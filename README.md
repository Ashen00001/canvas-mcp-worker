# canvas mcp

lets claude see your canvas. you ask it stuff like "what am i missing?" or "what's my grade in chem?" and it checks canvas for you, from your phone or computer, even when your own pc is off.

it can only **look**. it can't submit, edit, or delete anything in canvas. and only the github account(s) you pick can use it, so nobody else can see your grades.

it runs for free on cloudflare (the free plan is way more than enough).

---

## what you need

- a **canvas** login (your school's canvas, like `yourschool.instructure.com`)
- a **github** account (free, it's just used to sign in)
- a **cloudflare** account (free, make one at dash.cloudflare.com)
- a **claude.ai** account that can add custom connectors
- a computer with **node.js** installed (nodejs.org, the LTS one) for the setup. after setup you don't need the computer anymore

it takes about 20 minutes the first time.

---

## easiest way: let an ai do it

if you have claude code (or another coding agent):

1. download this repo and open the folder in claude code
2. say: **"set this up for me, follow AGENTS.md"**
3. it does everything it can by itself. it'll stop and ask you when it needs you, which is only for:
   - logging into cloudflare (a browser tab opens, you click allow)
   - making a github "oauth app" (a form with 3 boxes, it tells you exactly what to type)
   - pasting 3 secret codes into a box it opens for you (it never sees them)
   - clicking "approve" and "authorize" once at the end to test it

that's it. skip to [add it to claude](#add-it-to-claude) when it says it's done.

---

## doing it yourself

open a terminal in this folder (on windows: shift + right click the folder → "open in terminal").

**1. install stuff**

```
npm install
```

**2. log into cloudflare**

```
npx wrangler login
```

a browser tab opens. log in and click **allow**. if it says "timed out", log into dash.cloudflare.com in your browser first, then run it again.

**3. run setup**

change the two values to yours:

```
node scripts/setup.mjs init --canvas-url https://yourschool.instructure.com --github-user your-github-name
```

- `--canvas-url` is the address you see when you open canvas in a browser, just the start of it, no slashes at the end
- `--github-user` is your github username (not your email)

if it says your cloudflare account has no "workers.dev subdomain", run it again with `--subdomain somename` added at the end. pick anything, it becomes part of your server's address.

when it finishes it prints your server address and 3 lines for the next step. keep that window open.

**4. make the github sign-in app**

go to **github.com/settings/applications/new** and fill in exactly what setup printed:

- application name: `Canvas MCP`
- homepage url: your server address (setup printed it)
- authorization callback url: your server address + `/callback` (setup printed it)
- leave "enable device flow" unchecked

click **register application**. on the next page:

- you'll see the **client id**. copy it, you need it in step 5
- click **generate a new client secret**. copy it right away, github only shows it once

**5. save the 3 secrets**

run each of these and paste when it asks. what you paste is hidden, that's normal.

```
node scripts/set-secret.mjs GITHUB_CLIENT_ID
node scripts/set-secret.mjs GITHUB_CLIENT_SECRET
node scripts/set-secret.mjs CANVAS_API_TOKEN
```

for the canvas token: in canvas go to **account → settings**, scroll to **approved integrations**, click **+ new access token**, type `Claude` as the purpose, click **generate token**, and copy the long code it shows (about 70 characters, has a `~` in it). canvas only shows it once.

the script checks the canvas token with canvas before saving it, so if you pasted the wrong thing it tells you.

(on windows you can also use `powershell -File set-secret.ps1 CANVAS_API_TOKEN`, which opens a little box instead.)

**6. put it online**

```
node scripts/setup.mjs deploy
```

it uploads it and checks it's working. it prints the url to use in claude.

---

## add it to claude

do this once, on the claude.ai website on a computer. your phone picks it up automatically.

1. claude.ai → **settings → connectors → add custom connector**
2. name: `Canvas`. url: your server address with `/mcp` on the end (deploy printed it)
3. if it shows more options: pick **sign in now**, **register automatically**, and **streamable http**. leave headers empty
4. click add / connect
5. a "Canvas MCP" page opens → click **approve**
6. github asks to authorize → click **authorize**

then in any chat (phone too), open the tools / **+** menu and make sure **Canvas** is turned on. try "what's due this week?"

---

## if something breaks

- **"canvas token is invalid or expired"**: your canvas token ran out or got deleted. make a new one (step 5) with `node scripts/set-secret.mjs CANVAS_API_TOKEN`. no need to redeploy or reconnect
- **github says "this server is private"**: you signed in with a github account that isn't on the list. use the one you gave setup, or rerun `init` with the right `--github-user` and then `deploy`
- **connector won't connect**: check the url ends in `/mcp`. run `node scripts/setup.mjs status` to see what's missing
- **"final grade" looks way too low**: that's canvas counting every assignment that isn't graded yet as a zero. "current" is the one that matches what you see in canvas

---

## what it can see

courses and current grades, grades per assignment, assignment details, missing work, what's due soon, syllabus, modules, announcements, quizzes.

it does **not** do files, messages, or anything that changes canvas.

## good to know

- the canvas token is as powerful as your canvas password. this server only ever reads with it, but don't share it. if you think it leaked, delete it in canvas → settings
- your secrets live in your cloudflare account only, not in this folder and not on github
- the `wrangler.jsonc` file setup makes has your school and username in it. it's ignored by git on purpose, don't upload it

built on cloudflare's remote mcp github oauth template. mit license.
