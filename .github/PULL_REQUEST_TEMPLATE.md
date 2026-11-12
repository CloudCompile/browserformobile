## What does this change?

<!-- One paragraph: what a user will notice, and why it is worth doing. -->

## How was it verified?

- [ ] `npm run build`
- [ ] `npm run lint` (0 errors, 0 warnings)
- [ ] `npm test`
- [ ] Measured on device, for changes touching download, resume, repair, or memory

<!-- Say what you measured and how. This repo's fixes are picked by measurement;
     "should be faster" is treated as untested. -->

## Checklist

- [ ] CHANGELOG.md updated (under **Unreleased** if it exists)
- [ ] README updated for any user-visible behaviour change
- [ ] New persisted state rides `saveSettings()` / `PersistedShape`
- [ ] Listeners, timers, and intervals registered with the plugin's `register*` helpers
- [ ] No new network calls beyond the catalogue and the opt-in recommendation model
