import { Setting } from "obsidian";
import { getAutoSyncTiming } from "./autoSyncScheduler";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";

export const generateAutoSyncSettings = (
  container: HTMLElement,
  plugin: RemotelySavePlugin,
  t: (key: TransItemType, vars?: any) => string
) => {
  const enabledSetting = new Setting(container);
  const timingDiv = container.createDiv();
  const isEnabled = () =>
    (plugin.settings.syncOnSaveAfterMilliseconds ?? -1) > 0;
  enabledSetting
    .setName(t("settings_synconsave"))
    .setDesc(t("settings_synconsave_desc"))
    .addDropdown((dropdown) => {
      dropdown.addOption("-1", t("settings_synconsave_disable"));
      dropdown.addOption("1000", t("settings_synconsave_enable"));
      dropdown.setValue(isEnabled() ? "1000" : "-1").onChange(async (value) => {
        plugin.settings.syncOnSaveAfterMilliseconds = Number.parseInt(value);
        timingDiv.toggle(isEnabled());
        await plugin.saveSettings();
        plugin.toggleSyncOnSaveIfSet();
      });
    });
  timingDiv.toggle(isEnabled());

  const timing = getAutoSyncTiming(plugin.settings);
  const fields = [
    {
      key: "syncOnSaveDelayMilliseconds",
      name: "settings_synconsave_delay",
      desc: "settings_synconsave_delay_desc",
      value: timing.delay,
    },
    {
      key: "syncOnSaveMinIntervalMilliseconds",
      name: "settings_synconsave_interval",
      desc: "settings_synconsave_interval_desc",
      value: timing.minInterval,
    },
  ] as const;
  for (const field of fields) {
    new Setting(timingDiv)
      .setName(t(field.name))
      .setDesc(t(field.desc))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "3600";
        text.inputEl.step = "1";
        text.setValue(`${field.value / 1000}`).onChange(async (value) => {
          const seconds = Number(value);
          if (
            !/^\d+$/.test(value) ||
            !Number.isInteger(seconds) ||
            seconds < 1 ||
            seconds > 3600
          ) {
            text.inputEl.setCustomValidity(
              t("settings_synconsave_seconds_invalid")
            );
            return;
          }
          text.inputEl.setCustomValidity("");
          plugin.settings[field.key] = seconds * 1000;
          // Update the current queue in place: changing timing must not lose a
          // pending deletion or reset the last sync's cooldown.
          plugin.updateSyncOnSaveTiming();
          await plugin.saveSettings();
        });
      });
  }
};
