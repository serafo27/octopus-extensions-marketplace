# Calendar

Your Google, Outlook, iCloud and other calendars side by side in one Octopus section, together with local events you create by dragging.

## What it does

- **Day, week, month and agenda views** of every calendar you add, each in its own colour. You can show, hide, rename or recolour each calendar, or show only one.
- **Up next** in the sidebar: the meeting happening now or the next one, with a **Join** button for Meet, Zoom, Teams and Webex links. When several meetings overlap, it shows them as a carousel.
- **Event details**: time, location, description, organizer and attendees, plus buttons to copy the details or open the event in the browser.
- **Local events**: drag on the grid (or press `C`) to create one, then drag to move or resize it. They can repeat daily, weekly, monthly or yearly, and live in local calendars you can create.
- **Mute calendar** (a calendar's ⋯ menu): its events stay in the views, but leave the menu bar, **Up next**, notifications, auto join and what's shared with other extensions. Click the muted bell beside it to unmute.
- **Search** across titles, locations, descriptions and calendar names.
- **A notification** 1, 2, 3, 5 or 10 minutes before an event starts (1 by default; can be turned off).
- **Auto join** (off by default): 1, 2, 3, 5 or 10 minutes before a meeting you accepted (or organize) starts, its Meet, Zoom, Teams or Webex link opens by itself, as if you clicked Join. It needs the account name to be your email address, so the extension can tell which invites you accepted.
- **The Mac's menu bar** (off by default): today's next meeting as `Standup in 5m`, then `5m left`; after the last one of the day it shows only the date. Muted calendars aren't in it. Clicking it opens a menu like Notion Calendar's: the meeting under way or next ("Upcoming in 2 h 34 min") with a Join row for its call, then the rest of today and the next two days that have meetings; each one with a call has a submenu that starts with Join.
- **Shared with other extensions**: the next 14 days of your visible calendars (except muted ones) are published as `events`, for extensions you allow to read them (e.g. a daily check).

## What it needs

- **Read-only iCalendar (.ics) addresses**, not an account login. The extension can't change events in Google or Outlook: it only reads them.
  - Google: Settings → your calendar → *Integrate calendar* → *Secret address in iCal format*. Some Google Workspace admins turn this off.
  - Outlook / Microsoft 365: Settings → Calendar → Shared calendars → *Publish a calendar* ("Can view all details") → copy the ICS link.
  - iCloud: share the calendar as a *Public Calendar* and copy the link.
  - Any other public or secret `.ics` / `webcal://` address works too.
- **Permissions**
  - `http`: `calendar.google.com`, `outlook.office365.com`, `outlook.office.com` and `outlook.live.com`, to download the feeds. Any other host (iCloud's `pNN-caldav.icloud.com`, Fastmail, …) has to be added to `manifest.json`. The add dialog tells you which host is missing and copies a request you can paste to Claude.
  - `statusBar`, for the menu bar item.
- **No VPN**: the feeds are public internet addresses.
- **Data**: the calendar list, local events, settings and an offline copy of each feed (the last 120 days and everything after) are stored in Octopus's storage for this extension. Nothing is sent anywhere except the feed downloads. A secret ICS address is a password for that calendar, so don't share it.

## How to use it

1. Open **Calendar** in the activity bar and click **Add calendar** in the sidebar.
2. Pick the provider, follow the steps shown, paste the address and type an account name. Calendars with the same account name are grouped together. If the account name is your email address, the extension can tell which invites you declined.
3. Feeds refresh every 15 minutes. Press `R` or click ↻ to refresh them now. Changes made in Google or Outlook can take a while to appear in their feeds.
4. Go to **Settings** to set the first day of the week, the default event length, the hour height, weekends, declined events, notifications, auto join and the menu bar.

Keys: `T` today · `D` `W` `M` `A` views · `J`/`K` or `←`/`→` next and previous · `C` new event · `/` or `⌘F` search · `R` refresh · `?` all shortcuts.
