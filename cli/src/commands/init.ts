import { command, flag } from "cmd-ts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import pc from "picocolors";
import { installPlugin, getBundledPlugin, getInstalledPluginVersion } from "../cache";
import { findProjectRoot } from "../utils";

export const init = command({
  name: "init",
  description: "Install the openmodules plugin to the current project or globally",
  args: {
    global: flag({
      long: "global",
      short: "g",
      description: "Install globally to ~/.config/opencode/plugin/",
    }),
    force: flag({
      long: "force",
      short: "f",
      description: "Force reinstall even if same version exists",
    }),
  },
  handler: async ({ global: isGlobal, force }) => {
    const bundled = getBundledPlugin();
    if (!bundled) {
      console.error(pc.red("Error: Could not find bundled plugin"));
      console.error(pc.dim("The CLI may not be properly installed"));
      process.exit(1);
    }

    let targetDir: string;

    if (isGlobal) {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME;
      targetDir = xdgConfigHome
        ? path.join(xdgConfigHome, "opencode")
        : path.join(os.homedir(), ".config", "opencode");
    } else {
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        console.error(pc.red("Error: Not in a project directory"));
        console.error(pc.dim("Use --global to install globally, or run from a git repository"));
        process.exit(1);
      }
      targetDir = projectRoot;
    }

    const pluginPath = path.join(targetDir, ".opencode", "plugin", "openmodules.js");
    const existingVersion = getInstalledPluginVersion(pluginPath);

    if (existingVersion && existingVersion === bundled.version && !force) {
      console.log(pc.green(`✓ Plugin already installed (v${existingVersion})`));
      console.log(pc.dim(`  ${pluginPath}`));
      return;
    }

    const result = installPlugin(targetDir, { force });

    if ("error" in result) {
      console.error(pc.red(`Error: ${result.error}`));
      process.exit(1);
    }

    if (result.installed) {
      if (existingVersion) {
        console.log(pc.green(`✓ Plugin upgraded: v${existingVersion} → v${result.version}`));
      } else {
        console.log(pc.green(`✓ Plugin installed (v${result.version})`));
      }
    } else {
      console.log(pc.green(`✓ Plugin already up to date (v${result.version})`));
    }

    console.log(pc.dim(`  ${result.path}`));

    // Also create .openmodules directory if it doesn't exist
    const openmodulesDir = path.join(targetDir, ".openmodules");
    if (!fs.existsSync(openmodulesDir)) {
      fs.mkdirSync(openmodulesDir, { recursive: true });
      console.log(pc.dim(`  Created ${openmodulesDir}/`));
    }
  },
});
