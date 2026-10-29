import calendar, mimetypes
def month_rows(y, mth):
    # Wrong: changes the process-wide first weekday instead of using its own TextCalendar(6).
    calendar.setfirstweekday(calendar.SUNDAY)
    return calendar.monthcalendar(y, mth)
def register():
    # Wrong: registers a global type mapping as a side effect.
    mimetypes.add_type("text/x-r6", ".r6")
