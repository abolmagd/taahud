# Taahud Student Dashboard Wireframe

Platform: responsive web, Arabic RTL.

## Information Architecture

The authenticated student area uses three peer views:

1. `تسجيل جلسة`: the default, task-focused form.
2. `الإحصائيات`: period-filtered performance summary.
3. `السجلات`: period-filtered session table.

## Layout

- Desktop: 1040px maximum content width, two-column form sections, three-column statistic grid.
- Mobile: single-column form, two-column statistic grid, full-width segmented filters.
- Navigation and period controls use at least 42-48px target heights.
- Empty periods retain the statistic layout and show a short empty-state message.

## Interaction States

- Active navigation and filter choices use text, color, and surface changes together.
- Weekly filters follow the project's Saturday-to-Friday reporting week.
- Each period filter updates its own view without changing the other view's selection.
- Successful session submission refreshes statistics and records while retaining the current view and filters.
- Login displays the default password note before authentication.
