import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInNewContext } from "vm";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import { getAutoSyncTiming } from "../src/autoSyncScheduler";
import type { RemotelySavePluginSettings } from "../src/baseTypes";

describe("Configurable automatic sync settings", () => {
  let dom: JSDOM;
  let controls: any[];
  let container: HTMLElement;
  let plugin: any;
  let saved: any;
  let updated: number;
  let toggled: number;
  let render: () => void;

  beforeEach(() => {
    dom = new JSDOM("");
    const proto = dom.window.HTMLElement.prototype as any;
    proto.createDiv = function () {
      const div = dom.window.document.createElement("div");
      this.appendChild(div);
      return div;
    };
    proto.toggle = function (show: boolean) {
      this.hidden = !show;
    };
    controls = [];
    container = dom.window.document.createElement("div");
    updated = 0;
    toggled = 0;
    plugin = {
      settings: { syncOnSaveAfterMilliseconds: -1 },
      saveSettings: async () => {
        saved = JSON.parse(JSON.stringify(plugin.settings));
      },
      updateSyncOnSaveTiming: () => {
        updated++;
      },
      toggleSyncOnSaveIfSet: () => {
        toggled++;
      },
    };
    class MockSetting {
      element: HTMLElement;
      constructor(parent: HTMLElement) {
        this.element = parent.createDiv();
      }
      setName(name: string) {
        this.element.dataset.name = name;
        return this;
      }
      setDesc(desc: string) {
        this.element.dataset.desc = desc;
        return this;
      }
      addDropdown(callback: (control: any) => void) {
        return this.addControl("select", callback);
      }
      addText(callback: (control: any) => void) {
        return this.addControl("input", callback);
      }
      addControl(tag: string, callback: (control: any) => void) {
        const inputEl = dom.window.document.createElement(
          tag
        ) as HTMLInputElement;
        this.element.appendChild(inputEl);
        const control = {
          inputEl,
          change: undefined as any,
          addOption: () => control,
          setValue: (value: string) => {
            inputEl.value = value;
            return control;
          },
          onChange: (handler: any) => {
            control.change = handler;
            return control;
          },
        };
        controls.push(control);
        callback(control);
        return this;
      }
    }
    const module = { exports: {} as any };
    runInNewContext(
      transformSync(readFileSync(resolve("src/autoSyncSettings.ts"), "utf8"), {
        loader: "ts",
        format: "cjs",
        target: "es2020",
      }).code,
      {
        module,
        exports: module.exports,
        require: (name: string) =>
          name === "obsidian"
            ? { Setting: MockSetting }
            : { getAutoSyncTiming },
      }
    );
    render = () => {
      container.replaceChildren();
      controls = [];
      module.exports.generateAutoSyncSettings(
        container,
        plugin,
        (key: string) => key
      );
    };
    render();
  });

  afterEach(() => {
    dom.window.close();
  });

  it("shows timing controls only when sync on changes is enabled", async () => {
    const timingDiv = container.children[1] as HTMLElement;
    assert.equal(timingDiv.hidden, true);
    await controls[0].change("1000");
    assert.equal(timingDiv.hidden, false);
    assert.equal(toggled, 1);
    await controls[0].change("-1");
    assert.equal(timingDiv.hidden, true);
  });

  it("shows one interval and persists its value after reloading", async () => {
    await controls[0].change("1000");
    assert.equal(
      controls.length,
      2,
      "one enable dropdown and one timing field"
    );
    assert.equal(controls[1].inputEl.value, "10");
    await controls[1].change("60");
    assert.equal(saved.syncOnSaveMinIntervalMilliseconds, 60000);
    assert.equal(updated, 1);
    assert.equal(
      toggled,
      1,
      "timing changes must update the existing scheduler"
    );
    plugin.settings = saved;
    render();
    assert.equal(controls[1].inputEl.value, "60");
  });

  it("rejects invalid values without changing saved timing", async () => {
    await controls[1].change("5");
    for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "3601"]) {
      await controls[1].change(value);
      assert.equal(saved.syncOnSaveMinIntervalMilliseconds, 5000);
      assert.equal(controls[1].inputEl.validity.customError, true);
    }
    await controls[1].change("10");
    assert.equal(saved.syncOnSaveMinIntervalMilliseconds, 10000);
    assert.equal(controls[1].inputEl.validity.customError, false);
  });

  it("uses safe defaults and ignores the removed legacy delay", () => {
    const settings = {
      syncOnSaveDelayMilliseconds: 60000,
      syncOnSaveMinIntervalMilliseconds: -1,
    } as RemotelySavePluginSettings;
    assert.deepEqual(getAutoSyncTiming(settings), { interval: 10000 });
    settings.syncOnSaveMinIntervalMilliseconds = 60000;
    assert.equal(getAutoSyncTiming(settings).interval, 60000);
  });
});
