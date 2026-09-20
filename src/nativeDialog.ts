import {
  ask as askNative,
  open as openNative,
  save as saveNative,
  type ConfirmDialogOptions,
  type OpenDialogOptions,
  type OpenDialogReturn,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

import { showPointer } from "./api";

/**
 * The system's file and message dialogs, with the mouse pointer restored
 * first. Everything in the app opens them through here rather than through
 * `@tauri-apps/plugin-dialog` directly.
 *
 * macOS hides the pointer while the user types and brings it back at the
 * next mouse move this process handles — which is no move at all while a
 * file panel is up, so a panel opened off a typed command has no pointer in
 * it (`rz` opens one the moment the command is sent). `show_pointer` in
 * commands.rs clears that flag, and does nothing anywhere else.
 */
const pointer = () => showPointer().catch(() => undefined);

/** Picks files or a directory; see `plugin-dialog`'s `open`. */
export async function open<T extends OpenDialogOptions>(
  options?: T,
): Promise<OpenDialogReturn<T>> {
  await pointer();
  return openNative(options);
}

/** Picks where to write a file; see `plugin-dialog`'s `save`. */
export async function save(
  options?: SaveDialogOptions,
): Promise<string | null> {
  await pointer();
  return saveNative(options);
}

/** A yes / no question in a system dialog; see `plugin-dialog`'s `ask`. */
export async function ask(
  message: string,
  options?: string | ConfirmDialogOptions,
): Promise<boolean> {
  await pointer();
  return askNative(message, options);
}
