---
"mattpocock-skills": patch
---

Harden both implementation workflows against the JRB-014 failure modes: a clean-tree pre-flight aborts the run loudly before any child work when the checkout is dirty; transitions and merge confirmation get a 180s budget and a strict write-nothing contract; remediation escalates immediately when a failure repeats with an identical signature; and Agent Execution Evidence is reconciled (replace, never append) instead of accumulating duplicates across reruns.
