# Windows cloud calendar settings

`src/renderer/cloud-calendar-ui.js` exports `CloudCalendarUI.create(options)` in a browser and `{ create }` in CommonJS. Load `cloud-calendar.css` with the renderer styles.

Options: `invoke(action, args)`, `document`, `openDialog(title, html, footer, options)`, `getData()`, `notify(message)`, `buildSeries(data, reminderMinutes)`, `prepareData(data)` (async, defaults to identity), and optional injectable `storage` implementing `getItem`/`setItem` (defaults to document localStorage). Use the shared `CalendarLink.buildSeries` as the canonical series builder. Use `prepareData` to normalize and persist stable meeting IDs before building series; the app does so with `persist(normalized.data, { notifyCalendars: false })` to avoid recursive sync. The controller rechecks foreground state and data revision after preparation.

Controller methods:
- `openSettings()` opens the explicit provider/account/calendar selection flow.
- `onTimetableSaved(data)` performs best-effort foreground syncing after local persistence has succeeded. Its handled promise does not reject for a cloud failure. Do not make local persistence dependent on it.
- `ready` is the initial foreground/startup reconciliation promise. Instantiate after loading local data, or call `onTimetableSaved(loadedData)` after initial load to reconcile an already enabled connection.
- `dispose()` removes listeners and reports foreground false to native code.

## Native adapter contract

The adapter accepts these actions; map them to the actual native command names:

| Action | Arguments | Result |
| --- | --- | --- |
| `status` | `{ provider }` | `{ provider, state, accountLabel, target: { id, name } \| null, enabled, ownedCount }` |
| `cancel` | `{ provider }` | Cancels an authorization in progress |
| `connect` | `{ provider }` | Authorization only; no automatic target selection or writes |
| `targets` | `{ provider }` | `[{ id, name }]` or `{ targets: [...] }` |
| `create_target` | `{ provider: 'google', name }` | Explicit app-created dedicated calendar |
| `bind` | `{ provider, calendarId, confirmed: true }` | Explicit enablement |
| `sync` | `{ provider, series, allowDelete }` | `{ pendingDeleteCount }` for skipped removals |
| `disconnect` | `{ provider }` | Removes connection, retains events |
| `set_foreground` | `{ foreground }` | Native foreground gate |

Provider IDs are `google` and `microsoft`. Rejected promises or `{ ok: false, message }` / `{ error }` become inline errors. Missing configuration can be represented by `configured: false` or state `missing_config`, `unconfigured`, or `not_configured`.

Google's consent copy specifically describes `calendar.app.created` and app-created calendars. Microsoft copy describes the broader `Calendars.ReadWrite` permission and account selection. The UI does not imply OAuth access is already configured or verified. Native code remains responsible for credential protection, OAuth account choice, provider scopes, writable targets, owned-event mappings, concurrency, foreground enforcement, and recoverable request errors.

## Destructive reconciliation

Ordinary saves send `allowDelete: false`. A pending removal count exposes a separate review button and confirmation dialog. Only that confirmation sends `allowDelete: true`. A later local save invalidates a previously displayed confirmation so stale snapshots cannot remove newly saved course events. Queue snapshots carry an immutable revision across both providers. Immediately before deletion, the controller rechecks revision, foreground, enabled state, account label, and target ID. Subsequent saves wait for an already-confirmed in-flight deletion before reconciling their newer snapshot; a provider request already sent cannot be retroactively undone. Disconnecting does not remove existing events. There is no ICS fallback, timer, or network polling. Startup and visibility-return perform one event-driven reconciliation using current `getData()` after setting the native foreground gate. Only previously enabled targets receive writes; hidden saves are recovered from current local data on return.

## Reminder preferences and limits

Each provider has a local reminder preference: none (`null`), 5, 10, 15, or 30 minutes, defaulting to 10. The settings select saves the preference locally and applies it on the next sync; it does not itself send requests. The preference store contains no credentials. Changing the preference invalidates pending deletion confirmations. The canonical builder receives the chosen value as its second argument.

The settings explain the native limit of 1,000 concrete occurrences per sync, Google one popup reminder, Microsoft one reminder, and the possibility that provider/device settings suppress notification delivery.

## Renderer integration

Load `cloud-calendar-ui.js` after the canonical calendar builder and include `cloud-calendar.css`. Instantiate after local data has loaded:

```js
const cloudCalendar = CloudCalendarUI.create({
  invoke: (action, args) => bridge.cloudCalendar(action, args),
  document,
  openDialog,
  getData: () => data,
  notify,
  buildSeries: CalendarLink.buildSeries,
  prepareData: async data => {
    const normalized = CalendarLink.ensureMeetingIds(data);
    if (normalized.changed) await persist(normalized.data, { notifyCalendars: false });
    return normalized.data;
  }
});
// Settings command:
void cloudCalendar.openSettings();
// Only after successful local save (never await cloud before committing locally):
void cloudCalendar.onTimetableSaved(data);
```

The adapter receives the exact action names and argument objects in the table above, with provider `google` or `microsoft`. It must forward `series` unchanged and map `allowDelete` to the native argument without inferring deletion permission from a normal save. Native results can be returned directly; no `{ok:true}` wrapper is required.

## Verification

Run `node tests/cloud-calendar-ui.cjs`, `node tests/cloud-calendar-races.cjs`, and `node tests/cloud-calendar-app-dom.cjs`. The app smoke loads the actual index script order, Tauri bridge, app entrypoint, canonical builder, and menu/form handlers against simulated native IPC. Tests use the real controller in JSDOM with injected native responses and cover explicit provider/account/target consent, HTML escaping, local failure isolation, foreground-only saves, deferred deletion, stale confirmation rejection, in-flight stale-response rejection, disconnect, reminder persistence, enabled-only startup reconciliation, and foreground-return recovery without polling. They do not verify OAuth, provider service behavior, native storage, cloud event delivery, visual layout, or notification delivery.
