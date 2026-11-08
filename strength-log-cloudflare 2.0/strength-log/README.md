# Strength Log

A workout tracker that runs as a phone-friendly web app. One Cloudflare Worker serves the app (`public/`) and a small API (`src/`):

- **Workouts, history, progress, muscle diagram:** run entirely in the browser and work offline once installed.
- **Cloud backup** (`/api/state`): saves a copy of your data to D1, keyed by your device recovery code.
- **Food tab** (`/api/meals`): meals, saved nutrition labels (D1) and photos (R2). Photo analysis and the muscle lookup (`/api/muscles`) call the Anthropic API.

## Deploy from GitHub

1. **Push this folder to a GitHub repo.**

2. **Create the database and photo bucket** (one time, from this folder; needs Node 20+ and a Cloudflare account):

   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 create strength-log
   npx wrangler r2 bucket create strength-log-photos
   ```

   `d1 create` prints a `database_id`. Paste it into `wrangler.jsonc` in place of `PASTE-YOUR-D1-DATABASE-ID-HERE`, then create the tables and commit the change:

   ```sh
   npm run db:migrate
   git add wrangler.jsonc && git commit -m "Set D1 database id" && git push
   ```

   (R2 may need to be enabled on your Cloudflare account first, from the R2 page in the dashboard.)

3. **Connect the repo.** In the Cloudflare dashboard go to Workers & Pages, create a new application and import your GitHub repository. Leave the build command empty and keep the default deploy command (`npx wrangler deploy`). Every push to the main branch redeploys.

4. **Add your Anthropic key** (only needed for meal-photo analysis and the muscle lookup): in the Worker's settings, under Variables and Secrets, add a secret named `ANTHROPIC_API_KEY`. Without it the rest of the app works and those two features show a message.

5. Open the `*.workers.dev` address on your phone and add it to your Home Screen. Open it once with a connection so it can save itself for offline use.

Dashboard labels change now and then; if a name differs, look for the equivalent.

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars      # put your Anthropic key in .dev.vars
npm run db:migrate:local
npm run dev                         # http://localhost:8787
```

## Things to know

- **Data does not carry over from a previous host.** A new deployment starts empty. Use Settings, Export backup on the old one and Import backup on the new one.
- **No login.** The device recovery code is the only credential. Anyone who has it can read and overwrite that backup, so treat it like a password.
- **Size limit:** the cloud backup is capped just under 2 MB, because D1 limits a single row to about that size.
- **Free plan CPU limit:** Workers on the free plan allow very little CPU time per request. Big meal photos could hit it; if photo logging fails, the paid Workers plan lifts the limit.
- **Models:** `src/meals.js` and `src/muscles.js` both use `claude-sonnet-5-5`. Change the `MODEL` constants if you want others.
- **Muscle groups:** common exercises use a built-in table of mappings based on EMG research (in `public/index.html`, `MKEY` and `MRULES`). The AI is only asked about exercise names that table doesn't recognise.
