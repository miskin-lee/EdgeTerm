//! Import of the OpenSSH client configuration (`~/.ssh/config`) as saved SSH
//! sessions. Every `Host` alias becomes one profile, resolved the way `ssh
//! alias` resolves it: the first value found wins, so a `Host *` block sets
//! defaults for everything after it, `Include` splices files in place and
//! `ProxyJump` hops become the profile's jump host chain.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{AuthKind, SessionKind, SessionProfile};
use crate::store::Store;

/// Files an `Include` chain may nest; OpenSSH stops at the same depth.
const MAX_INCLUDE_DEPTH: usize = 16;
/// Identities `ssh` offers when a host names none. It tries all of them; a
/// profile holds one, so the newest algorithm found on disk is taken.
const DEFAULT_IDENTITIES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

/// One `Host` alias, resolved to what `ssh alias` would connect to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    /// `ProxyJump` hops, first hop first: aliases of the same file or
    /// `[user@]host[:port]` literals.
    #[serde(default)]
    pub jumps: Vec<String>,
    /// A saved SSH session that already stands for this alias — same name,
    /// or same host, port and user. Importing the alias updates it in place
    /// instead of adding a twin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_name: Option<String>,
}

/// What an import of `path` would bring in, for the dialog to choose from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigPreview {
    pub path: String,
    pub entries: Vec<SshConfigEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportSummary {
    pub added: usize,
    pub updated: usize,
    /// Profiles created beyond the selection because a selected host
    /// tunnels through them.
    pub jump_hosts: usize,
    /// Hosts whose multi-hop `ProxyJump` was left unimported; the sessions
    /// themselves were still saved, just without a jump host.
    pub jumps_ignored: usize,
    /// Links that could not be made, one line each; the profiles themselves
    /// were still saved.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// The machine-side facts the file is read against.
#[derive(Debug, Clone)]
pub struct Context {
    /// Expands `~` and `%d`.
    pub home: Option<PathBuf>,
    /// Relative `Include` paths resolve against the directory holding the
    /// user configuration, `~/.ssh`.
    pub ssh_dir: PathBuf,
    /// `%u`, and the user of an alias that names none — `ssh` logs in as
    /// the local user then.
    pub local_user: String,
    /// The identity `ssh` would offer when a host names none, if one of the
    /// default files exists.
    pub default_identity: Option<String>,
}

impl Context {
    pub fn from_environment() -> Self {
        let home = dirs::home_dir();
        let ssh_dir = home
            .as_deref()
            .map(|home| home.join(".ssh"))
            .unwrap_or_else(|| PathBuf::from(".ssh"));
        let local_user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default();
        let default_identity = DEFAULT_IDENTITIES
            .iter()
            .map(|name| ssh_dir.join(name))
            .find(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned());
        Context {
            home,
            ssh_dir,
            local_user,
            default_identity,
        }
    }

    /// The file `ssh` reads by default, whether or not it exists yet.
    pub fn default_config_path(&self) -> PathBuf {
        self.ssh_dir.join("config")
    }

    fn expand_tilde(&self, value: &str) -> String {
        match (value.strip_prefix('~'), &self.home) {
            (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
                format!("{}{}", home.to_string_lossy(), rest)
            }
            _ => value.to_string(),
        }
    }

    /// The percent tokens `IdentityFile` accepts, plus `~`.
    fn expand_identity(&self, value: &str, host: &str, user: &str) -> String {
        let home = self
            .home
            .as_deref()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_default();
        let expanded = expand_tokens(value, |token| match token {
            'd' => Some(home.clone()),
            'u' => Some(self.local_user.clone()),
            'h' => Some(host.to_string()),
            'r' => Some(user.to_string()),
            _ => None,
        });
        self.expand_tilde(&expanded)
    }
}

/// Replaces `%x` tokens the way `ssh` does; `%%` is a percent sign and a
/// token `substitute` does not know is left in place.
fn expand_tokens(value: &str, substitute: impl Fn(char) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('%') => {
                chars.next();
                out.push('%');
            }
            Some(token) => match substitute(token) {
                Some(replacement) => {
                    chars.next();
                    out.push_str(&replacement);
                }
                None => out.push('%'),
            },
            None => out.push('%'),
        }
    }
    out
}

// --- parsing ----------------------------------------------------------------

/// The options between one `Host` / `Match` line and the next. The block
/// before the first one has the pattern `*`; a `Match` with real criteria
/// has none, since only a live connection could evaluate them.
struct Block {
    patterns: Vec<String>,
    options: Vec<(String, String)>,
}

struct Parser<'a> {
    context: &'a Context,
    blocks: Vec<Block>,
    included: Vec<PathBuf>,
}

impl<'a> Parser<'a> {
    fn new(context: &'a Context) -> Self {
        Parser {
            context,
            blocks: vec![Block {
                patterns: vec!["*".to_string()],
                options: Vec::new(),
            }],
            included: Vec::new(),
        }
    }

    fn feed(&mut self, text: &str, depth: usize) {
        for raw in text.lines() {
            let line = raw.trim();
            // Only a whole comment line is a comment: `ssh` treats a `#`
            // after a value as part of it.
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((keyword, value)) = split_keyword(line) else {
                continue;
            };
            match keyword.as_str() {
                "host" => self.blocks.push(Block {
                    patterns: split_args(value),
                    options: Vec::new(),
                }),
                "match" => self.blocks.push(Block {
                    patterns: if value.trim().eq_ignore_ascii_case("all") {
                        vec!["*".to_string()]
                    } else {
                        Vec::new()
                    },
                    options: Vec::new(),
                }),
                // Spliced in place: inside a Host block the included lines
                // extend that block, and a Host line in the included file
                // starts a new one that the lines after the Include continue.
                "include" => {
                    for pattern in split_args(value) {
                        self.include(&pattern, depth);
                    }
                }
                _ => self
                    .blocks
                    .last_mut()
                    .expect("parser always holds a block")
                    .options
                    .push((keyword, unquote(value))),
            }
        }
    }

    fn include(&mut self, pattern: &str, depth: usize) {
        if depth >= MAX_INCLUDE_DEPTH {
            return;
        }
        for path in self.expand_include(pattern) {
            if self.included.contains(&path) {
                continue;
            }
            self.included.push(path.clone());
            // A file that is missing or unreadable is skipped, as ssh does.
            if let Ok(text) = std::fs::read_to_string(&path) {
                self.feed(&text, depth + 1);
            }
        }
    }

    /// The files an `Include` names: `~` expanded, relative to `~/.ssh`,
    /// with wildcards in the file name (`config.d/*`) matched on disk.
    fn expand_include(&self, pattern: &str) -> Vec<PathBuf> {
        let expanded = self.context.expand_tilde(pattern);
        let path = if Path::new(&expanded).is_absolute() {
            PathBuf::from(expanded)
        } else {
            self.context.ssh_dir.join(expanded)
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        if !has_wildcard(&name) {
            return vec![path];
        }
        let Some(parent) = path.parent() else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(parent) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|candidate| pattern_matches(&name, candidate))
            })
            .collect();
        found.sort();
        found
    }
}

/// Splits a line into its lower-cased keyword and the rest, allowing the
/// `Keyword value` and `Keyword=value` spellings alike.
fn split_keyword(line: &str) -> Option<(String, &str)> {
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = line[..end].to_ascii_lowercase();
    if keyword.is_empty() {
        return None;
    }
    let mut rest = line[end..].trim_start();
    if let Some(stripped) = rest.strip_prefix('=') {
        rest = stripped.trim_start();
    }
    Some((keyword, rest.trim_end()))
}

/// Whitespace-separated words, with double quotes grouping a word.
fn split_args(value: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut pending = false;
    for c in value.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                pending = true;
            }
            c if c.is_whitespace() && !quoted => {
                if pending {
                    args.push(std::mem::take(&mut current));
                    pending = false;
                }
            }
            c => {
                current.push(c);
                pending = true;
            }
        }
    }
    if pending {
        args.push(current);
    }
    args
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    match trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        Some(inner) => inner.to_string(),
        None => trimmed.to_string(),
    }
}

fn has_wildcard(pattern: &str) -> bool {
    pattern.contains(['*', '?'])
}

/// OpenSSH's pattern match: `*` any run, `?` one character, case folded
/// like host names are.
fn pattern_matches(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();
    glob(&pattern, &text)
}

fn glob(pattern: &[char], text: &[char]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some(('*', rest)) => (0..=text.len()).any(|skip| glob(rest, &text[skip..])),
        Some(('?', rest)) => !text.is_empty() && glob(rest, &text[1..]),
        Some((c, rest)) => text.first() == Some(c) && glob(rest, &text[1..]),
    }
}

/// Whether a block's patterns select `alias`: a negated pattern that
/// matches vetoes the block, otherwise any matching pattern selects it.
fn block_applies(block: &Block, alias: &str) -> bool {
    let mut matched = false;
    for pattern in &block.patterns {
        match pattern.strip_prefix('!') {
            Some(negated) => {
                if pattern_matches(negated, alias) {
                    return false;
                }
            }
            None => matched |= pattern_matches(pattern, alias),
        }
    }
    matched
}

/// Aliases in file order: every pattern that names one host rather than a
/// family of them. Repeats are one alias; `ssh` merges their blocks.
fn aliases(blocks: &[Block]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for block in blocks {
        for pattern in &block.patterns {
            if pattern.starts_with('!') || has_wildcard(pattern) || pattern.is_empty() {
                continue;
            }
            if !found
                .iter()
                .any(|known| known.eq_ignore_ascii_case(pattern))
            {
                found.push(pattern.clone());
            }
        }
    }
    found
}

/// The options `ssh alias` ends up with: the first value of each keyword
/// across the blocks that select the alias, in file order.
fn resolve(blocks: &[Block], alias: &str) -> HashMap<String, String> {
    let mut options = HashMap::new();
    for block in blocks.iter().filter(|block| block_applies(block, alias)) {
        for (keyword, value) in &block.options {
            options
                .entry(keyword.clone())
                .or_insert_with(|| value.clone());
        }
    }
    options
}

fn entry_for(alias: &str, options: &HashMap<String, String>, context: &Context) -> SshConfigEntry {
    let host = options
        .get("hostname")
        .map(|value| expand_tokens(value, |token| (token == 'h').then(|| alias.to_string())))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| alias.to_string());
    let port = options
        .get("port")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(22);
    let username = options
        .get("user")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| context.local_user.clone());
    let named_identity = options
        .get("identityfile")
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        .map(|value| context.expand_identity(value, &host, &username));
    let (auth, private_key_path) = match named_identity.or_else(|| context.default_identity.clone())
    {
        Some(key) => (AuthKind::PublicKey, Some(key)),
        None => (AuthKind::Password, None),
    };
    let jumps = options
        .get("proxyjump")
        .filter(|value| !value.eq_ignore_ascii_case("none"))
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|hop| !hop.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    SshConfigEntry {
        alias: alias.to_string(),
        host,
        port,
        username,
        auth,
        private_key_path,
        jumps,
        existing_id: None,
        existing_name: None,
    }
}

/// Parses configuration text; `Include` directives are read from disk.
pub fn parse_text(text: &str, context: &Context) -> Vec<SshConfigEntry> {
    let mut parser = Parser::new(context);
    parser.feed(text, 0);
    aliases(&parser.blocks)
        .iter()
        .map(|alias| entry_for(alias, &resolve(&parser.blocks, alias), context))
        .collect()
}

pub fn parse_file(path: &Path, context: &Context) -> Result<Vec<SshConfigEntry>> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| AppError::new(format!("cannot read {}: {error}", path.display())))?;
    Ok(parse_text(&text, context))
}

// --- matching saved sessions ------------------------------------------------

/// A saved SSH session that already stands for the alias: one named after
/// it, or one that connects to the same host, port and user.
fn matching_profile<'a>(
    profiles: &'a [SessionProfile],
    alias: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Option<&'a SessionProfile> {
    let ssh = || {
        profiles
            .iter()
            .filter(|profile| profile.kind == SessionKind::Ssh)
    };
    ssh().find(|profile| profile.name == alias).or_else(|| {
        ssh().find(|profile| {
            profile
                .host
                .as_deref()
                .is_some_and(|saved| saved.eq_ignore_ascii_case(host))
                && profile.port.unwrap_or(22) == port
                && profile.username.as_deref() == Some(username)
        })
    })
}

fn annotate(entries: &mut [SshConfigEntry], profiles: &[SessionProfile]) {
    for entry in entries {
        let existing = matching_profile(
            profiles,
            &entry.alias,
            &entry.host,
            entry.port,
            &entry.username,
        );
        entry.existing_id = existing.map(|profile| profile.id.clone());
        entry.existing_name = existing.map(|profile| profile.name.clone());
    }
}

/// Reads `path` and says which of its aliases the store already knows.
pub fn preview(store: &Store, path: &Path, context: &Context) -> Result<SshConfigPreview> {
    Ok(SshConfigPreview {
        path: path.to_string_lossy().into_owned(),
        entries: preview_entries(store, parse_file(path, context)?),
    })
}

/// Marks each entry with the saved session it would update, if any.
pub fn preview_entries(store: &Store, mut entries: Vec<SshConfigEntry>) -> Vec<SshConfigEntry> {
    annotate(&mut entries, &store.list());
    entries
}

// --- import -----------------------------------------------------------------

/// A `ProxyJump` hop written out: `[user@]host[:port]`, with `[v6]:port`.
fn parse_hop(token: &str) -> (Option<String>, String, u16) {
    let (user, rest) = match token.rsplit_once('@') {
        Some((user, rest)) if !user.is_empty() => (Some(user.to_string()), rest),
        _ => (None, token),
    };
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        match inner.split_once(']') {
            Some((host, port)) => (host, port.strip_prefix(':')),
            None => (inner, None),
        }
    } else {
        match rest.rsplit_once(':') {
            // A bare IPv6 address has colons of its own and no port.
            Some((host, port)) if !host.contains(':') => (host, Some(port)),
            _ => (rest, None),
        }
    };
    let port = port
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(22);
    (user, host.to_string(), port)
}

/// A brand-new profile for an entry, filed under `group_id`.
fn new_profile(entry: &SshConfigEntry, group_id: Option<String>) -> SessionProfile {
    SessionProfile {
        id: String::new(),
        name: entry.alias.clone(),
        kind: SessionKind::Ssh,
        color: None,
        group_id,
        encoding: None,
        locale: None,
        backspace: None,
        record: false,
        record_dir: None,
        shell: None,
        cwd: None,
        host: Some(entry.host.clone()),
        port: Some(entry.port),
        username: Some(entry.username.clone()),
        auth: Some(entry.auth),
        password: None,
        private_key_path: entry.private_key_path.clone(),
        passphrase: None,
        jump_profile_id: None,
        port_name: None,
        baud_rate: None,
        data_bits: None,
        stop_bits: None,
        parity: None,
        flow_control: None,
    }
}

/// Brings a saved profile up to date with the file. Everything the file
/// does not speak about — name, colour, group, encoding, a jump host set
/// by hand — stays. The authentication only changes when the file names
/// a key: switching a password profile to the default identity would also
/// drop its stored password.
fn update_profile(profile: &mut SessionProfile, entry: &SshConfigEntry, named_key: bool) {
    profile.host = Some(entry.host.clone());
    profile.port = Some(entry.port);
    profile.username = Some(entry.username.clone());
    if named_key {
        profile.auth = Some(entry.auth);
        profile.private_key_path = entry.private_key_path.clone();
    }
}

/// Saves the selected aliases of `entries` as SSH profiles: a matching
/// saved session is updated in place, anything else is added under
/// `group_id`. Only a single-hop `ProxyJump` is imported as a jump host: the
/// hop comes along (a named alias, or a `user@host:port` literal given its
/// own profile) and the session is linked to it. A `ProxyJump` with more
/// than one hop is dropped with a warning — EdgeTerm's per-session jump host
/// cannot hold a chain, and one host's chain must not reshape the jump hosts
/// other sessions share (see `jumps_ignored`).
pub fn import(
    store: &Store,
    entries: &[SshConfigEntry],
    selected: &[String],
    group_id: Option<String>,
    context: &Context,
) -> Result<SshImportSummary> {
    let mut summary = SshImportSummary::default();
    let index_of = |alias: &str| {
        entries
            .iter()
            .position(|entry| entry.alias.eq_ignore_ascii_case(alias))
    };

    let mut needed = vec![false; entries.len()];
    for alias in selected {
        if let Some(index) = index_of(alias) {
            needed[index] = true;
        }
    }
    // Close the selection over the single jump host each host names. A
    // multi-hop ProxyJump is not imported, so it pulls nothing in.
    loop {
        let mut changed = false;
        for index in 0..entries.len() {
            if !needed[index] {
                continue;
            }
            if let Some(hop) = single_hop(&entries[index]) {
                let (_, host, _) = parse_hop(hop);
                if let Some(target) = index_of(&host).filter(|target| !needed[*target]) {
                    needed[target] = true;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // First every profile, so each has an id; then the single jump link.
    let mut ids: Vec<Option<String>> = vec![None; entries.len()];
    for (index, entry) in entries.iter().enumerate() {
        if !needed[index] {
            continue;
        }
        let profiles = store.list();
        let existing = matching_profile(
            &profiles,
            &entry.alias,
            &entry.host,
            entry.port,
            &entry.username,
        );
        let saved = match existing {
            Some(existing) => {
                let mut profile = store.get(&existing.id)?.unwrap_or_else(|| existing.clone());
                let named_key = entry.private_key_path.is_some()
                    && entry.private_key_path != context.default_identity;
                update_profile(&mut profile, entry, named_key);
                summary.updated += 1;
                store.save(profile)?
            }
            None => {
                summary.added += 1;
                store.save(new_profile(entry, group_id.clone()))?
            }
        };
        ids[index] = Some(saved.id);
    }

    for (index, entry) in entries.iter().enumerate() {
        if !needed[index] {
            continue;
        }
        if entry.jumps.len() > 1 {
            summary.jumps_ignored += 1;
            summary.warnings.push(format!(
                "{}: its ProxyJump has {} hops; multi-hop jumps are not imported, \
                 so set a jump host by hand if you need one",
                entry.alias,
                entry.jumps.len()
            ));
            continue;
        }
        let (Some(id), Some(hop)) = (&ids[index], single_hop(entry)) else {
            continue;
        };
        let (user, host, port) = parse_hop(hop);
        let hop_id = match index_of(&host).and_then(|target| ids[target].clone()) {
            Some(id) => id,
            None => match literal_hop_profile(store, &user, &host, port, &group_id, context) {
                Ok((hop_id, created)) => {
                    if created {
                        summary.jump_hosts += 1;
                    }
                    hop_id
                }
                Err(error) => {
                    summary
                        .warnings
                        .push(format!("{}: jump host {hop}: {error}", entry.alias));
                    continue;
                }
            },
        };
        if let Err(error) = link_jump(store, id, &hop_id, true) {
            summary.warnings.push(format!("{}: {error}", entry.alias));
        }
    }
    Ok(summary)
}

/// The one `ProxyJump` hop of an entry, or `None` when it has none or names
/// a chain of several (which is not imported).
fn single_hop(entry: &SshConfigEntry) -> Option<&String> {
    match entry.jumps.as_slice() {
        [hop] => Some(hop),
        _ => None,
    }
}

/// The profile for a hop written as `[user@]host[:port]`: an existing one
/// that connects there, else a new one named after the host. Returns
/// whether it was created.
fn literal_hop_profile(
    store: &Store,
    user: &Option<String>,
    host: &str,
    port: u16,
    group_id: &Option<String>,
    context: &Context,
) -> Result<(String, bool)> {
    let username = user.clone().unwrap_or_else(|| context.local_user.clone());
    let profiles = store.list();
    if let Some(existing) = matching_profile(&profiles, "", host, port, &username) {
        return Ok((existing.id.clone(), false));
    }
    let (auth, private_key_path) = match &context.default_identity {
        Some(key) => (AuthKind::PublicKey, Some(key.clone())),
        None => (AuthKind::Password, None),
    };
    let entry = SshConfigEntry {
        alias: host.to_string(),
        host: host.to_string(),
        port,
        username,
        auth,
        private_key_path,
        jumps: Vec::new(),
        existing_id: None,
        existing_name: None,
    };
    let saved = store.save(new_profile(&entry, group_id.clone()))?;
    Ok((saved.id, true))
}

/// Points `id` at `jump_id`; with `replace` false only where it has no jump
/// host yet. The store refuses a chain that loops or runs too deep.
fn link_jump(store: &Store, id: &str, jump_id: &str, replace: bool) -> Result<()> {
    let Some(mut profile) = store.get(id)? else {
        return Ok(());
    };
    if profile.jump_profile_id.as_deref() == Some(jump_id)
        || (!replace && profile.jump_profile_id.is_some())
        || id == jump_id
    {
        return Ok(());
    }
    profile.jump_profile_id = Some(jump_id.to_string());
    store.save(profile).map(|_| ())
}
