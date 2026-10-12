# Daily

A morning board for Octopus: your meetings, tasks in progress, the weather and the news on one page.

## What it shows

- **Sky and timeline**: a sky that follows the hour and the weather, with today's meetings drawn on its horizon. Click it to unfold one row per meeting.
- **Greeting and summary**: a few sentences on the day. Written by the extension, or by Claude if you pick that in the settings.
- **At a glance**: the current or next meeting (with a Join button), meetings left, the longest free block before the end of your working day, tasks in progress.
- **Today's meetings**: one-off meetings and unanswered invitations are flagged. Each has a Join button when it has a meeting link.
- **Weather**: now, today's range, and the chance of rain hour by hour.
- **Tasks in progress**: tasks in *doing* (and *review*, if you want) from every Octopus project. Click one to open it on its board.
- **Later this week**: the one-off meetings in the rest of the week. Recurring meetings are left out.
- **News**: headlines from ANSA, BBC World, Hacker News and Il Post.

From the toolbar you can copy the day as Markdown, reload everything, or open the settings.

## What it needs

- **Permissions**
  - `http`: Open-Meteo (weather and city search) and the news sites above, for feeds and pictures.
  - `claude`: only used if you choose the summary written by Claude (Haiku, a few seconds).
  - `tasks`: reads your tasks. It never creates or changes them.
  - `shared: calendar`: reads the events the **Calendar** extension shares.
- **Calendar extension**: meetings come from it. Without it, or before it has loaded once today, the meeting sections stay empty and a notice says why. Open Calendar once to share or update the events.
- **No VPN and no accounts**: all the sources are public and need no key.
- **Data**: the settings and the last Claude summary are kept in Octopus's storage for this extension. Your meetings and tasks go to Claude only if you turn on the Claude summary.

## How to use it

1. Install it, along with the Calendar extension, and open Calendar once.
2. Open **Daily** from the activity bar.
3. Open the settings (gear icon) and set your **name** for the greeting, your **city**, the sections and news sources you want, when your working day ends, and who writes the summary.

The board refreshes every minute and when you come back to it. Weather and news are fetched again at most every 20 minutes.
