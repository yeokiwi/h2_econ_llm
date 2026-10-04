# H2 Econs Question Lab

A website that uses the [OpenRouter](https://openrouter.ai) API to generate Singapore-Cambridge A-Level **H2 Economics (9570)** questions, suggested answers and mark schemes. All generation follows [`SKILL.md`](SKILL.md): the 2026 syllabus scope, the command-word conventions, the JC prelim mark schemes, the analytical chains and the Stand + ATMS evaluation style.

## What it does

- **Three paper types**
  - **Case study (Paper 1)**: extracts, data tables and drawn figures, then 6–7 part-questions totalling 30 marks.
  - **Essay (Paper 2)**: 1–3 essays, each with a preamble, (a) [10] and (b) [15]. You can pick Section A (micro) or Section B (macro).
  - **Practice set**: stand-alone 2/4/8/10-mark questions, each with its own short stimulus.
- **Controls**: syllabus topics (codes 1.1.1–3.3.1), context (Singapore, another economy, or a specific issue you type in), difficulty, and extra instructions.
- **Answers**: choose questions only, questions with suggested answers, or answers plus mark schemes, and full model answers or outlines. Answers stay **hidden until you reveal them**, so students can try the questions first. If you chose questions only, you can generate the answers later.
- **Follow-ups** on the same paper, for example "mark my answer to (c)(ii)", "make (d) harder" or "give me revision notes".
- **Figures** are drawn as real charts with a data-table view. Economics diagrams in answers are described in words and drawn as labelled ASCII sketches.
- **Other features**: copy, download as Markdown (with or without answers, with figures turned into tables), print (answers print only when revealed), history saved in the browser, light and dark themes, a mobile layout, and any OpenRouter model (`anthropic/claude-sonnet-5.5` by default).

## Running it

The site is plain HTML, CSS and JavaScript with no build step. It needs to be served over HTTP because it loads `SKILL.md` at runtime.

### Option 1: each user brings their own OpenRouter key

```bash
npm start            # or: python3 -m http.server 8080
```

Open <http://localhost:8080>, click **API key** and paste a key from <https://openrouter.ai/keys>. The browser calls OpenRouter directly. The key is kept for the session, or saved in `localStorage` if you tick "Remember on this device".

This mode also works on any static host, such as GitHub Pages: publish the repository root.

### Option 2: the server holds the key

```bash
OPENROUTER_API_KEY=sk-or-v1-... ACCESS_CODE=choose-a-code npm start
```

The browser then sends requests to `POST /api/chat` on `server.js`, which forwards them to OpenRouter with the server's key. Users don't need a key of their own.

**Set `ACCESS_CODE` on any public deployment**, or anyone who finds the URL can spend your credits. Users enter the code under **API key**.

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Turns on proxy mode. |
| `ACCESS_CODE` | Code users must enter before using the server's key (recommended). |
| `OPENROUTER_MODEL` | Default model shown to users, e.g. `openai/gpt-5.5`. |
| `PORT`, `HOST` | Where to listen. Defaults are `8080` and `0.0.0.0`. |

`server.js` serves only `index.html`, `SKILL.md` and `assets/`. It needs Node 18 or later and has no dependencies.

## How the prompt is built

`assets/js/prompts.js` combines two things for each request:

1. **System message**: the full text of `SKILL.md` plus the site's output rules:
   - write Markdown
   - give marks as `[n]`
   - put chart data in ```` ```chart ```` JSON blocks
   - draw diagrams as ASCII sketches
   - write a `=== ANSWERS ===` line between the questions and the answers, which the UI uses to hide the answers

   For `anthropic/*` models this message is marked for prompt caching, so repeat requests cost less.
2. **User message**: the task built from the form (workflow C in the skill), the topics, context, difficulty, answer style and any notes.

To change how questions and answers are written, edit `SKILL.md`. The site picks the changes up on reload.

## Development

```bash
npm test   # node:test, covering the prompt builder, SSE streaming parser, chart parsing and server routing/auth
```

| Path | Contents |
|---|---|
| `index.html`, `assets/styles.css` | The UI |
| `assets/js/app.js` | Form, streaming, rendering, history and export |
| `assets/js/prompts.js` | Prompt construction and question/answer splitting |
| `assets/js/openrouter.js` | OpenRouter streaming client |
| `assets/js/charts.js` | Chart parsing and Chart.js rendering |
| `assets/js/syllabus.js` | Syllabus topic list |
| `server.js` | Optional static server and key-holding proxy |

marked, DOMPurify and Chart.js load from cdnjs with SRI hashes. Model output is sanitised before it is rendered.
