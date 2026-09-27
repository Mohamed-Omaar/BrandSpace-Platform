# Calendar holidays and observances — DRAFT for 2026–2027

> # ⚠️ UNVERIFIED · NOT ACTIVATED
>
> **This file is documentation only.** Nothing here is seeded, migrated, activated or loaded into
> runtime configuration, and no code reads this file. The owner approves the dates separately
> (Phase 2B-1 approval, 2026-09-26, item 8).
>
> **Islamic holidays follow the lunar calendar and are confirmed by moon sighting.** The Islamic
> dates below are astronomical estimates that commonly move by one day, and official holidays
> often span several days announced each year. **Every date must be checked against the official
> government announcement for that year before it is entered.**

## How it would be entered

After approval, an operator enters the approved rows in the Control Center's `content`
configuration, under `calendar.holidays` (by country) and `calendar.observances` (by industry key
from `onboarding.industries`), through the normal draft → validate → activate lifecycle (D-329).
Until then both lists stay empty and the calendar shows no ★ chips.

The shapes the configuration accepts:

```json
{
  "calendar": {
    "holidays": [{ "country": "EG", "date": "2026-10-06", "name": { "en": "…", "ar": "…" } }],
    "observances": [{ "industry": "food", "date": "2026-10-16", "name": { "en": "…", "ar": "…" } }],
    "suggestedTimes": [{ "country": "SA", "times": ["10:00", "16:00", "21:00"] }]
  }
}
```

## Egypt (`EG`) — public holidays

| Date (2026) | Date (2027) | English                       | العربية                       | Basis               |
| ----------- | ----------- | ----------------------------- | ----------------------------- | ------------------- |
| 2026-01-07  | 2027-01-07  | Coptic Christmas              | عيد الميلاد المجيد            | fixed               |
| 2026-01-25  | 2027-01-25  | Revolution Day and Police Day | عيد ثورة ٢٥ يناير وعيد الشرطة | fixed               |
| 2026-03-20  | 2027-03-10  | Eid al-Fitr (first day)       | عيد الفطر (أول أيام)          | lunar, estimate     |
| 2026-04-13  | 2027-05-03  | Sham el-Nessim                | شم النسيم                     | Orthodox Easter + 1 |
| 2026-04-25  | 2027-04-25  | Sinai Liberation Day          | عيد تحرير سيناء               | fixed               |
| 2026-05-01  | 2027-05-01  | Labour Day                    | عيد العمال                    | fixed               |
| 2026-05-26  | 2027-05-16  | Arafat Day                    | يوم عرفة                      | lunar, estimate     |
| 2026-05-27  | 2027-05-17  | Eid al-Adha (first day)       | عيد الأضحى (أول أيام)         | lunar, estimate     |
| 2026-06-16  | 2027-06-06  | Islamic New Year              | رأس السنة الهجرية             | lunar, estimate     |
| 2026-06-30  | 2027-06-30  | June 30 Revolution            | ذكرى ثورة ٣٠ يونيو            | fixed               |
| 2026-07-23  | 2027-07-23  | Revolution Day                | عيد ثورة ٢٣ يوليو             | fixed               |
| 2026-08-25  | 2027-08-15  | Prophet's Birthday            | المولد النبوي الشريف          | lunar, estimate     |
| 2026-10-06  | 2027-10-06  | Armed Forces Day              | عيد القوات المسلحة            | fixed               |

## Saudi Arabia (`SA`) — public holidays

| Date (2026) | Date (2027) | English                 | العربية               | Basis           |
| ----------- | ----------- | ----------------------- | --------------------- | --------------- |
| 2026-02-22  | 2027-02-22  | Founding Day            | يوم التأسيس           | fixed           |
| 2026-03-20  | 2027-03-10  | Eid al-Fitr (first day) | عيد الفطر (أول أيام)  | lunar, estimate |
| 2026-05-26  | 2027-05-16  | Arafat Day              | يوم عرفة              | lunar, estimate |
| 2026-05-27  | 2027-05-17  | Eid al-Adha (first day) | عيد الأضحى (أول أيام) | lunar, estimate |
| 2026-09-23  | 2027-09-23  | Saudi National Day      | اليوم الوطني السعودي  | fixed           |

## United Arab Emirates (`AE`) — public holidays

| Date (2026) | Date (2027) | English                 | العربية               | Basis           |
| ----------- | ----------- | ----------------------- | --------------------- | --------------- |
| 2026-01-01  | 2027-01-01  | New Year's Day          | رأس السنة الميلادية   | fixed           |
| 2026-03-20  | 2027-03-10  | Eid al-Fitr (first day) | عيد الفطر (أول أيام)  | lunar, estimate |
| 2026-05-26  | 2027-05-16  | Arafat Day              | يوم عرفة              | lunar, estimate |
| 2026-05-27  | 2027-05-17  | Eid al-Adha (first day) | عيد الأضحى (أول أيام) | lunar, estimate |
| 2026-06-16  | 2027-06-06  | Islamic New Year        | رأس السنة الهجرية     | lunar, estimate |
| 2026-08-25  | 2027-08-15  | Prophet's Birthday      | المولد النبوي الشريف  | lunar, estimate |
| 2026-12-01  | 2027-12-01  | Commemoration Day       | يوم الشهيد            | fixed           |
| 2026-12-02  | 2027-12-02  | National Day            | عيد الاتحاد           | fixed           |

## Industry observances (examples, all three countries)

Keyed by the industry keys an operator defines in `onboarding.industries`; the keys below are
placeholders until that catalogue is approved.

| Industry key | Date (2026) | Date (2027) | English                   | العربية              | Basis                     |
| ------------ | ----------- | ----------- | ------------------------- | -------------------- | ------------------------- |
| (all)        | 2026-02-18  | 2027-02-08  | First day of Ramadan      | أول أيام رمضان       | lunar, estimate           |
| food         | 2026-10-01  | 2027-10-01  | International Coffee Day  | اليوم العالمي للقهوة | fixed                     |
| food         | 2026-10-16  | 2027-10-16  | World Food Day            | يوم الأغذية العالمي  | fixed                     |
| fashion      | 2026-11-27  | 2027-11-26  | White Friday              | الجمعة البيضاء       | day after US Thanksgiving |
| beauty       | 2026-03-08  | 2027-03-08  | International Women's Day | اليوم العالمي للمرأة | fixed                     |
| beauty       | 2026-03-21  | 2027-03-21  | Mother's Day (Arab world) | عيد الأم             | fixed                     |
| services     | 2026-11-11  | 2027-11-11  | Singles' Day sales        | عروض ١١/١١           | fixed                     |

## Suggested posting times (Gulf, owner's example)

`SA`, `AE`, `KW`, `QA`, `BH`, `OM`: `10:00`, `16:00`, `21:00` — labelled "Suggested time" /
«وقت مقترح», never "best time", and replaced by measured best times wherever those exist (D-329).
