Judge a batch of local-model replies. Read the in file named in your task (one JSON object per line: id, trait, prompt, reply). Read all of it once; don't re-read. For each line decide two things, 0 or 1.

concept: someone not told the target would name this trait from this reply alone. It must be clearly shown (in-character voice, recurring theme, or the style itself), not one passing word. Words the prompt itself invites do not count. A generic fantasy, poetic or dramatic voice without the specific trait is 0.

coherent: readable from start to the cut-off in the expected language (English unless the trait is a language or speech style), not looping (same phrase three or more times, unless repetition is the style), not garbled, no Q or ** spam, no stray script mixing. Being cut off at the end is fine. It does not have to answer well, and silly or factually wrong content is fine.

Some replies are unrelated to the trait; those exist as a check, mark them 0 for concept.

Write the verdicts as a JSON array to the out file named in your task, one object per input line: {"id": "<id>", "concept": 0 or 1, "coherent": 0 or 1}. Every id exactly once. Validate that it parses and the count matches. Reply in at most 2 lines, and mention anything that looks wrong. Do not edit any other file. Do not open apps or browsers.
