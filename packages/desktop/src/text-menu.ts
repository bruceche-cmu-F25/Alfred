import { Menu, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from "electron";

/** Native editing commands for the text under the pointer in either workbench view. */
export function installTextMenu(window: BrowserWindow, contents: WebContents): void {
  contents.on("context-menu", (_event, { isEditable, editFlags, frame }) => {
    if (!isEditable && !editFlags.canCopy) return;

    const items: MenuItemConstructorOptions[] = isEditable ? [
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    ] : [{ role: "copy" }];
    Menu.buildFromTemplate(items).popup({ window, frame: frame ?? undefined });
  });
}
