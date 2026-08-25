//! Parses `~/.ssh/config` and resolves host aliases, including ProxyJump chains.
//!
//! The parser implements a subset of the OpenSSH client configuration syntax
//! that is relevant for terminal session management:
//!
//! - `Host` patterns (including wildcards `*` and `?`, and negation `!`)
//! - `HostName`, `Port`, `User`, `IdentityFile`
//! - `ProxyJump` (single hop or comma-separated multi-hop chains)
//! - `HostKeyAlias`
//! - Include directives (recursively, with cycle detection)
//!
//! Options not understood by EdgeTerm are silently ignored, matching
//! OpenSSH's forward-compatible behaviour.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{AuthKind, SessionProfile};

/// One parsed `Host` block from the SSH config file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// The raw `Host` pattern(s) from the config file, e.g. `["web-*", "!web-old"]`.
    pub patterns: Vec<String>,
    /// Resolved display name — the first non-wildcard pattern, or the full
    /// pattern string if every pattern contains wildcards.
    pub name: String,
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub host_key_alias: Option<String>,
}

/// A ready-to-use session profile derived from the SSH config, with all
/// ProxyJump hops resolved into a human-readable chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    /// The alias the user types after `ssh`, e.g. `my-server`.
    pub alias: String,
    /// Effective host name (resolved from `HostName` or the alias itself).
    pub host: String,
    /// Effective port (resolved from `Port` or 22).
    pub port: u16,
    /// Effective username (resolved from `User` or the OS user).
    pub user: String,
    /// Path to the identity file, if specified.
    pub identity_file: Option<String>,
    /// ProxyJump chain as typed in the config, e.g. `jump1,jump2`.
    pub proxy_jump: Option<String>,
    /// Resolved chain of hops, from first jump to the final target.
    /// Each hop has host, port, and user resolved.
    pub hops: Vec<SshConfigHop>,
    /// Host key alias, if specified.
    pub host_key_alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHop {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// True when this hop is the final destination rather than a jump host.
    pub is_target: bool,
}

/// The fully parsed SSH config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SshConfig {
    /// All `Host` blocks in file order. Options accumulate per the OpenSSH
    /// "first-match wins" rule, so earlier blocks have higher priority.
    pub hosts: Vec<SshConfigHost>,
}

impl SshConfig {
    /// Reads and parses the default user SSH config (`~/.ssh/config`).
    pub fn load_default() -> Result<Self> {
        let path = default_config_path();
        Self::load_from(&path)
    }

    /// Parses one or more SSH config files. `~/.ssh/config` is the entry point;
    /// `Include` directives are followed recursively.
    pub fn load_from(path: &Path) -> Result<Self> {
        let mut visited = HashSet::new();
        let mut hosts = Vec::new();
        parse_file(path, &mut visited, &mut hosts)?;
        Ok(SshConfig { hosts })
    }

    /// Resolves a host alias into a complete session profile, following
    /// ProxyJump chains and applying OpenSSH's first-match-wins option
    /// resolution.
    pub fn resolve(&self, alias: &str) -> Result<SshConfigEntry> {
        let resolved = self.resolve_options(alias);
        let host_name = resolved
            .host_name
            .unwrap_or_else(|| alias.to_string());
        let port = resolved.port.unwrap_or(22);
        let user = resolved
            .user
            .unwrap_or_else(|| whoami::username());
        let identity_file = resolved.identity_file;
        let proxy_jump = resolved.proxy_jump.clone();

        // Build the hop chain.
        let mut hops = Vec::new();
        if let Some(ref pj) = proxy_jump {
            for jump_alias in pj.split(',') {
                let jump_alias = jump_alias.trim();
                if jump_alias.is_empty() {
                    continue;
                }
                let jump_resolved = self.resolve_options(jump_alias);
                let jump_host = jump_resolved
                    .host_name
                    .unwrap_or_else(|| jump_alias.to_string());
                let jump_port = jump_resolved.port.unwrap_or(22);
                let jump_user = jump_resolved
                    .user
                    .unwrap_or_else(|| whoami::username());
                hops.push(SshConfigHop {
                    host: jump_host,
                    port: jump_port,
                    user: jump_user,
                    is_target: false,
                });
            }
        }
        hops.push(SshConfigHop {
            host: host_name.clone(),
            port,
            user: user.clone(),
            is_target: true,
        });

        Ok(SshConfigEntry {
            alias: alias.to_string(),
            host: host_name,
            port,
            user,
            identity_file,
            proxy_jump,
            hops,
            host_key_alias: resolved.host_key_alias,
        })
    }

    /// Returns the list of concrete host aliases (patterns without wildcards)
    /// that can be directly used as session profiles.
    pub fn list_hosts(&self) -> Vec<String> {
        self.hosts
            .iter()
            .flat_map(|h| &h.patterns)
            .filter(|p| !p.contains('*') && !p.contains('?') && !p.starts_with('!'))
            .map(|p| p.to_string())
            .collect()
    }

    /// Resolves all options for a given alias by walking the host blocks in
    /// order and applying first-match-wins semantics.
    fn resolve_options(&self, alias: &str) -> ResolvedOptions {
        let mut resolved = ResolvedOptions::default();
        for host in &self.hosts {
            if pattern_matches(&host.patterns, alias) {
                // First match wins: only set fields that are still None.
                if resolved.host_name.is_none() {
                    resolved.host_name = host.host_name.clone();
                }
                if resolved.port.is_none() {
                    resolved.port = host.port;
                }
                if resolved.user.is_none() {
                    resolved.user = host.user.clone();
                }
                if resolved.identity_file.is_none() {
                    resolved.identity_file = host.identity_file.clone();
                }
                if resolved.proxy_jump.is_none() {
                    resolved.proxy_jump = host.proxy_jump.clone();
                }
                if resolved.host_key_alias.is_none() {
                    resolved.host_key_alias = host.host_key_alias.clone();
                }
            }
        }
        resolved
    }

    /// Converts all concrete host aliases into session profiles ready for the
    /// frontend. Wildcard-only blocks are skipped.
    pub fn to_entries(&self) -> Vec<SshConfigEntry> {
        self.list_hosts()
            .iter()
            .filter_map(|alias| self.resolve(alias).ok())
            .collect()
    }
}

#[derive(Debug, Default)]
struct ResolvedOptions {
    host_name: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
    host_key_alias: Option<String>,
}

/// Checks if any of the patterns match the given host alias.
/// Negated patterns (`!host`) exclude a match.
fn pattern_matches(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        let pat = pattern.as_str();
        if let Some(neg) = pat.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(pat, alias) {
            matched = true;
        }
    }
    matched
}

/// Simple glob matcher supporting `*` (any sequence) and `?` (single char).
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    glob_match_inner(&p, &t)
}

fn glob_match_inner(p: &[char], t: &[char]) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    match p[0] {
        '*' => {
            // Try matching zero or more characters.
            for i in 0..=t.len() {
                if glob_match_inner(&p[1..], &t[i..]) {
                    return true;
                }
            }
            false
        }
        '?' => {
            if t.is_empty() {
                false
            } else {
                glob_match_inner(&p[1..], &t[1..])
            }
        }
        c => {
            if t.is_empty() || t[0] != c {
                false
            } else {
                glob_match_inner(&p[1..], &t[1..])
            }
        }
    }
}

/// Parses one SSH config file, following `Include` directives recursively.
fn parse_file(
    path: &Path,
    visited: &mut HashSet<PathBuf>,
    hosts: &mut Vec<SshConfigHost>,
) -> Result<()> {
    let canonical = match fs::canonicalize(path) {
        Ok(c) => c,
        Err(_) => return Ok(()), // File doesn't exist — silently skip.
    };
    if !visited.insert(canonical.clone()) {
        return Ok(()); // Already parsed — avoid cycles.
    }

    let contents = fs::read_to_string(&canonical)
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", canonical.display())))?;

    parse_string(&contents, &canonical, visited, hosts)
}

/// Parses config text, handling `Include` relative to the file's directory.
fn parse_string(
    contents: &str,
    base_dir: &Path,
    visited: &mut HashSet<PathBuf>,
    hosts: &mut Vec<SshConfigHost>,
) -> Result<()> {
    let mut current: Option<SshConfigHost> = None;

    for (line_no, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();

        // Skip comments and empty lines.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (keyword, value) = match split_kv(line) {
            Some(pair) => pair,
            None => continue, // Malformed line — skip silently.
        };

        let kw_lower = keyword.to_lowercase();

        match kw_lower.as_str() {
            "host" => {
                // Flush the current block.
                if let Some(mut block) = current.take() {
                    block.name = derive_display_name(&block.patterns);
                    hosts.push(block);
                }
                let patterns: Vec<String> = value
                    .split_whitespace()
                    .map(|s| s.to_string())
                    .collect();
                current = Some(SshConfigHost {
                    patterns,
                    ..Default::default()
                });
            }
            "hostname" => {
                if let Some(ref mut block) = current {
                    block.host_name = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(ref mut block) = current {
                    if let Ok(port) = value.parse::<u16>() {
                        block.port = Some(port);
                    }
                }
            }
            "user" => {
                if let Some(ref mut block) = current {
                    block.user = Some(value.to_string());
                }
            }
            "identityfile" | "identitycertificatefile" => {
                if let Some(ref mut block) = current {
                    block.identity_file = Some(expand_tilde(value));
                }
            }
            "proxyjump" => {
                if let Some(ref mut block) = current {
                    block.proxy_jump = Some(value.to_string());
                }
            }
            "hostkeyalias" => {
                if let Some(ref mut block) = current {
                    block.host_key_alias = Some(value.to_string());
                }
            }
            "include" => {
                // Follow include directives relative to the config file's directory.
                for pattern in value.split_whitespace() {
                    let expanded = expand_tilde(pattern);
                    let include_path = if Path::new(&expanded).is_absolute() {
                        PathBuf::from(&expanded)
                    } else {
                        base_dir.join(&expanded)
                    };
                    // Handle glob patterns in includes (e.g., config.d/*).
                    for matched in glob_paths(&include_path) {
                        parse_file(&matched, visited, hosts)?;
                    }
                }
            }
            _ => {
                // Ignore unrecognized options — forward compatible.
            }
        }

        let _ = line_no; // Used for debugging if needed.
    }

    // Flush the last block.
    if let Some(mut block) = current {
        block.name = derive_display_name(&block.patterns);
        hosts.push(block);
    }

    Ok(())
}

/// Splits a config line into keyword and value at the first whitespace.
fn split_kv(line: &str) -> Option<(&str, &str)> {
    let mut iter = line.splitn(2, char::is_whitespace);
    let keyword = iter.next()?.trim();
    let value = iter.next()?.trim();
    if keyword.is_empty() || value.is_empty() {
        return None;
    }
    Some((keyword, value))
}

/// Picks the best display name from a list of Host patterns.
/// Prefers the first pattern without wildcards.
fn derive_display_name(patterns: &[String]) -> String {
    for p in patterns {
        if !p.contains('*') && !p.contains('?') && !p.starts_with('!') {
            return p.clone();
        }
    }
    // All wildcards — join them for a display name.
    patterns
        .iter()
        .filter(|p| !p.starts_with('!'))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Expands `~` to the user's home directory.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Resolves glob patterns in include paths (e.g., `config.d/*.conf`).
fn glob_paths(pattern: &Path) -> Vec<PathBuf> {
    let pattern_str = pattern.to_string_lossy();
    if !pattern_str.contains('*') && !pattern_str.contains('?') {
        // No glob — just check existence.
        if pattern.exists() {
            return vec![pattern.to_path_buf()];
        }
        return vec![];
    }

    // Simple glob: split into directory and filename pattern.
    let parent = pattern.parent();
    let file_name = pattern.file_name();

    match (parent, file_name) {
        (Some(parent), Some(file_name)) => {
            let pattern_str = file_name.to_string_lossy();
            let mut results = Vec::new();
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if glob_match(&pattern_str, &name) {
                        results.push(entry.path());
                    }
                }
            }
            results.sort();
            results
        }
        _ => vec![],
    }
}

/// Returns the default SSH config path (`~/.ssh/config`).
fn default_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh")
        .join("config")
}

/// Converts an [`SshConfigEntry`] into a [`SessionProfile`] that EdgeTerm can
/// open directly. The profile uses `Agent` auth when an identity file is
/// present (EdgeTerm loads it via `PublicKey` auth), or `Agent` otherwise
/// (relying on the system ssh-agent).
pub fn entry_to_profile(entry: &SshConfigEntry) -> SessionProfile {
    let auth = if entry.identity_file.is_some() {
        AuthKind::PublicKey
    } else {
        AuthKind::Agent
    };

    SessionProfile {
        id: String::new(),
        name: entry.alias.clone(),
        kind: crate::model::SessionKind::Ssh,
        color: None,
        shell: None,
        cwd: None,
        host: Some(entry.host.clone()),
        port: Some(entry.port),
        username: Some(entry.user.clone()),
        auth: Some(auth),
        password: None,
        private_key_path: entry.identity_file.clone(),
        passphrase: None,
        port_name: None,
        baud_rate: None,
        data_bits: None,
        stop_bits: None,
        parity: None,
        flow_control: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_basic_patterns() {
        assert!(glob_match("web-*", "web-prod"));
        assert!(glob_match("web-*", "web-"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("server?", "server1"));
        assert!(!glob_match("server?", "server12"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "other"));
    }

    #[test]
    fn pattern_matches_handles_negation() {
        let patterns = vec!["web-*".to_string(), "!web-old".to_string()];
        assert!(pattern_matches(&patterns, "web-prod"));
        assert!(!pattern_matches(&patterns, "web-old"));
        assert!(!pattern_matches(&patterns, "db-1"));
    }

    #[test]
    fn parse_simple_config() {
        let config = r#"
            # My SSH config
            Host prod
                HostName prod.example.com
                Port 2222
                User admin
                IdentityFile ~/.ssh/prod_key

            Host staging
                HostName staging.example.com
                User deploy
        "#;

        let mut hosts = Vec::new();
        let mut visited = HashSet::new();
        parse_string(
            config,
            Path::new("/tmp/test_config"),
            &mut visited,
            &mut hosts,
        )
        .unwrap();

        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].name, "prod");
        assert_eq!(hosts[0].host_name.as_deref(), Some("prod.example.com"));
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[0].user.as_deref(), Some("admin"));
        assert!(hosts[0].identity_file.is_some());
        assert_eq!(hosts[1].name, "staging");
        assert_eq!(hosts[1].port, None); // Default port
    }

    #[test]
    fn parse_proxy_jump() {
        let config = r#"
            Host bastion
                HostName bastion.example.com
                User jumpuser

            Host internal
                HostName 10.0.0.42
                User root
                ProxyJump bastion
        "#;

        let mut hosts = Vec::new();
        let mut visited = HashSet::new();
        parse_string(
            config,
            Path::new("/tmp/test_pj"),
            &mut visited,
            &mut hosts,
        )
        .unwrap();

        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[1].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn resolve_options_first_match_wins() {
        let config = r#"
            Host *
                User defaultuser
                Port 2222

            Host prod
                HostName prod.example.com
                User admin
        "#;

        let mut hosts = Vec::new();
        let mut visited = HashSet::new();
        parse_string(
            config,
            Path::new("/tmp/test_resolve"),
            &mut visited,
            &mut hosts,
        )
        .unwrap();

        let ssh_config = SshConfig { hosts };
        let resolved = ssh_config.resolve("prod").unwrap();

        // `User admin` from the `prod` block wins over `User defaultuser` from `*`.
        assert_eq!(resolved.user, "admin");
        // `Port 2222` from `*` applies because `prod` doesn't override it.
        assert_eq!(resolved.port, 2222);
        assert_eq!(resolved.host, "prod.example.com");
    }

    #[test]
    fn resolve_proxy_jump_chain() {
        let config = r#"
            Host jump1
                HostName jump1.example.com
                User juser

            Host jump2
                HostName jump2.example.com
                Port 2222
                User juser2

            Host target
                HostName 10.0.0.42
                User root
                ProxyJump jump1,jump2
        "#;

        let mut hosts = Vec::new();
        let mut visited = HashSet::new();
        parse_string(
            config,
            Path::new("/tmp/test_chain"),
            &mut visited,
            &mut hosts,
        )
        .unwrap();

        let ssh_config = SshConfig { hosts };
        let resolved = ssh_config.resolve("target").unwrap();

        assert_eq!(resolved.hops.len(), 3);
        assert_eq!(resolved.hops[0].host, "jump1.example.com");
        assert_eq!(resolved.hops[0].user, "juser");
        assert!(!resolved.hops[0].is_target);

        assert_eq!(resolved.hops[1].host, "jump2.example.com");
        assert_eq!(resolved.hops[1].port, 2222);
        assert_eq!(resolved.hops[1].user, "juser2");
        assert!(!resolved.hops[1].is_target);

        assert_eq!(resolved.hops[2].host, "10.0.0.42");
        assert_eq!(resolved.hops[2].user, "root");
        assert!(resolved.hops[2].is_target);
    }

    #[test]
    fn list_hosts_skips_wildcards() {
        let config = r#"
            Host *
                User default

            Host web-*
                User webuser

            Host prod
                HostName prod.example.com

            Host staging
                HostName staging.example.com
        "#;

        let mut hosts = Vec::new();
        let mut visited = HashSet::new();
        parse_string(
            config,
            Path::new("/tmp/test_list"),
            &mut visited,
            &mut hosts,
        )
        .unwrap();

        let ssh_config = SshConfig { hosts };
        let host_list = ssh_config.list_hosts();
        assert!(host_list.contains(&"prod".to_string()));
        assert!(host_list.contains(&"staging".to_string()));
        assert!(!host_list.contains(&"*".to_string()));
        assert!(!host_list.contains(&"web-*".to_string()));
    }

    #[test]
    fn entry_to_profile_uses_public_key_when_identity_present() {
        let entry = SshConfigEntry {
            alias: "prod".to_string(),
            host: "prod.example.com".to_string(),
            port: 22,
            user: "admin".to_string(),
            identity_file: Some("/home/user/.ssh/id_ed25519".to_string()),
            proxy_jump: None,
            hops: vec![],
            host_key_alias: None,
        };
        let profile = entry_to_profile(&entry);
        assert_eq!(profile.auth, Some(AuthKind::PublicKey));
        assert_eq!(profile.private_key_path.as_deref(), Some("/home/user/.ssh/id_ed25519"));
        assert_eq!(profile.host.as_deref(), Some("prod.example.com"));
    }

    #[test]
    fn entry_to_profile_uses_agent_when_no_identity() {
        let entry = SshConfigEntry {
            alias: "staging".to_string(),
            host: "staging.example.com".to_string(),
            port: 22,
            user: "deploy".to_string(),
            identity_file: None,
            proxy_jump: None,
            hops: vec![],
            host_key_alias: None,
        };
        let profile = entry_to_profile(&entry);
        assert_eq!(profile.auth, Some(AuthKind::Agent));
        assert!(profile.private_key_path.is_none());
    }
}