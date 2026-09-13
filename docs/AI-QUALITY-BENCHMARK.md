# AI Quality Benchmark — the Arabic gate

> **الملخص التنفيذي بالعربية**
>
> لا يجوز تفعيل أي نموذج ذكاء اصطناعي لخدمة العملاء في بيئة الإنتاج قبل اجتيازه تقييمًا موثّقًا
> ومقارنًا جنبًا إلى جنب على محتوى تسويقي عربي. يحدّد هذا المستند معايير التقييم، وطريقة التسجيل،
> ومن يعتمد النتيجة. **الاعتماد النهائي لأي نموذج يعود لمالك المنتج.**

**Status:** the gate is **defined and enforced**. No benchmark has been run, and no model has been
selected. Running one requires the owner's go-ahead — D-17 and D-13 both reserve vendor selection.

**Decision:** D-17, approved 2026-09-13.

> No provider/model may be enabled for production customer routing until it passes a documented
> side-by-side Arabic marketing-content benchmark.

---

## 1. Why this document exists

Arabic output quality is recorded in `docs/DECISIONS.md` §6 as the single biggest quality risk in the
product. A model that writes fluent English marketing copy can produce Arabic that is grammatically
correct and commercially useless — or worse, confidently wrong in a way an English-speaking reviewer
cannot see.

The gate therefore cannot be "somebody tried it and it seemed fine". It has to be a **side-by-side**
comparison, against **written criteria**, with a **recorded result** that names who approved it.

---

## 2. How the gate is enforced

`ai.models` carries `qualityBenchmarkRef` — where the benchmark for that model is written down.
Configuration validation refuses to activate a model at status `available` without it:

```
D-17: model "<key>" cannot be generally available until it has passed the Arabic
quality benchmark. Record the benchmark reference, or keep the model in beta
while it is evaluated.
```

**`beta` is deliberately exempt.** Beta is the status a model occupies _while_ it is being
benchmarked; a gate that blocked beta would make the evaluation impossible to run. The gate sits
between beta and general availability — which is where customer traffic actually arrives.

`available` is the only status that puts customer traffic on a model, so it is the only one gated.
`deprecated` models are being retired and `disabled` ones are unreachable.

---

## 3. What the benchmark must evaluate

Every criterion below is required by D-17. A model that is not assessed against all of them has not
passed the gate, however good its scores on the rest.

| #   | Criterion                                       | What a failure looks like                                                                                                   |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Arabic grammar and spelling**                 | Agreement errors, wrong hamza forms, broken plurals, missing or misplaced diacritics where they change meaning              |
| 2   | **Modern Standard Arabic quality**              | Register that drifts into dialect where MSA was asked for, or stilted translationese that reads as machine output           |
| 3   | **Saudi/Gulf localisation** _(where requested)_ | Levantine or Egyptian vocabulary in copy meant for a Saudi audience; culturally wrong references, dates or forms of address |
| 4   | **Brand Voice adherence**                       | Ignoring the brand's stated tone, do/don't rules, or glossary — in either language                                          |
| 5   | **Instruction following**                       | Overrunning a length limit, ignoring a required call to action, answering a different question                              |
| 6   | **Marketing usefulness and originality**        | Generic filler that could describe any brand; repeated phrasing across variants                                             |
| 7   | **English/Arabic consistency**                  | The two language versions making different claims, or differing in offer, price or call to action                           |
| 8   | **Safety and factual reliability**              | Invented statistics, fabricated product claims, unsafe or non-compliant assertions                                          |
| 9   | **Structured-output reliability**               | JSON that fails its schema, or degrades when the prompt is in Arabic but holds in English                                   |
| 10  | **Latency and cost**                            | p95 latency beyond the task's target, or a cost basis that cannot reach the D-15 margin target                              |

Criteria 7 and 9 are the ones most often skipped and most often the cause of a production incident:
a model that is reliable in English and not in Arabic will pass a casual review and fail a customer.

---

## 4. Method

1. **Fix the prompt set before looking at any output.** A shared set of real marketing tasks —
   captions, a monthly plan, a strategy brief, a translation — in both languages, covering at least
   one brand with an explicit Saudi/Gulf localisation requirement.
2. **Side by side.** Every candidate model receives an identical prompt set through the same routing
   parameters. A comparison where the prompts differed proves nothing.
3. **Blind where practical.** Scorers should not know which model produced which output.
4. **At least one native Arabic marketing reviewer.** Criteria 1–4 and 6 cannot be scored by a
   non-native speaker, and cannot be scored by a model.
5. **Record cost and latency from the same run** that produced the quality scores, so criterion 10
   reflects the same configuration.
6. **Write the result down** — scores per criterion, the prompt set, the reviewers, the date, and the
   configuration used — and put its reference in `qualityBenchmarkRef`.

---

## 5. What this gate does NOT do

- It does not select a vendor. D-13 reserves that: _"Provider architecture approved; exact providers
  pending benchmark, privacy verification and owner approval."_
- It does not authorise paid evaluation runs. Those need the owner's go-ahead.
- It does not replace the **privacy and data-processing review** (D-13), which is a separate gate
  recorded on the provider rather than the model. A model may pass this benchmark and still be
  unusable because its provider retains our data.
- It does not set prices. Criterion 10 feeds the D-15 calibration; it does not perform it.

---

## 6. Related

| Document                      | What it covers                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `docs/AI-GATEWAY.md` §4       | The model registry, the cost basis, and the status lifecycle the gate sits in |
| `docs/AI-GATEWAY.md` §5       | Routing rules — which model actually serves a task                            |
| `docs/BILLING-AND-CREDITS.md` | The D-15 margin target and how a credit price is derived from measured cost   |
| `docs/DECISIONS.md` §4.3      | D-13, D-15, D-16 and D-17 as approved                                         |
