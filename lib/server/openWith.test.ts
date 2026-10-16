import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openWithInvocation } from "@/lib/server/openWith";

const file = "/tmp/versions/abc/notes/a.txt";
const folder = "/tmp/versions/abc";

describe("open with the system chooser", () => {
  it("asks the system which app to use and passes that one file", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const plan = openWithInvocation(file, platform);
      const text = [plan.command, ...plan.args].join("\n");
      assert.equal(plan.args.filter((arg) => arg === file).length, 1, platform);
      assert.equal(plan.args.includes(folder), false, platform);
      assert.doesNotMatch(text, /Xcode|Visual Studio|TextEdit|VS Code|code\.desktop/i, platform);
      if (platform === "darwin") {
        assert.match(text, /choose application/);
        assert.match(text, /open -a/);
        assert.doesNotMatch(text, /-R/);
        assert.equal(plan.args.at(-1), file);
        assert.equal(plan.args.slice(0, -1).some((arg) => arg.includes(file)), false);
      } else if (platform === "win32") {
        assert.equal(plan.command, "rundll32.exe");
        assert.match(plan.args[0]!, /OpenAs_RunDLL/);
        assert.equal(plan.args[1], file);
      } else {
        assert.equal(plan.command, "python3");
        assert.match(text, /AppChooserDialog/);
        assert.match(text, /set_show_all\(True\)/);
        assert.match(text, /set_show_other\(True\)/);
        assert.equal(plan.args.at(-1), file);
      }
    }
  });
});
