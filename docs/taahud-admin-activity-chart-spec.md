# Taahud Admin Activity Chart

Platform: responsive Arabic RTL web dashboard.

## Data Encoding

- Bar height represents total points for each day.
- The value above each bar repeats the exact point total in text.
- The label below each bar shows weekday and date.
- Session and page totals remain visible as supporting text and in the accessible label.
- Zero values use a zero-height bar; they never display a false minimum column.

## Responsive Layout

- Desktop and tablet: seven vertical columns in a full-width dashboard panel.
- Mobile: seven compact horizontal rows with a proportional bar, point value, date, sessions, and pages.
- Meaningful bars use the existing gold activity color with a teal cap.

## States

- Mixed data: bars scale against the highest point total in the seven-day range.
- All zero: labels and zero values remain visible while all bars stay empty.
- Assistive technology: the chart is a list with one complete text label per day.
