# Fortnight Shop

Your fortnight grocery list (Aldi and Woolworths, recipes, Made history, Charters Towers aisles) as an app
you install from the browser, with no app store. Two phones signed in to the same account stay in sync live.

* **Login and sync:** Supabase (free plan)
* **Hosting:** GitHub Pages (free)
* **Photos, recipe links and price estimates:** your Claude API key (pay as you go, a few cents a time)

Your list never goes in this repository. It lives in your Supabase project, locked to your login.

---

## 1. Supabase (about 10 minutes, once)

1. Go to **supabase.com** → sign up → **New project**. Name it `fortnight-shop` and pick the **Sydney** region.
   Save the database password somewhere (you won't need it day to day).
2. When it's ready: **SQL Editor** → **New query** → paste everything in `supabase-setup.sql` → **Run**.
3. **Authentication → Users → Add user → Create new user.** Enter the email and password you'll both use,
   and tick **Auto Confirm User**.
4. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up",
   so nobody else can make an account on your project.
5. **Project Settings → Data API** (or **API Keys**): copy the **Project URL** and the
   **publishable / anon** key. Never use the `service_role` or secret key in the app.

## 2. Hosting on GitHub Pages

1. Put these files in a GitHub repository (Claude can push them for you).
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save**.
3. A minute later the app is at `https://<your-github-name>.github.io/<repo-name>/`.
4. Optional: put the Supabase URL and publishable key in `config.js`, so phones skip the setup screen.

## 3. Install on your phone

* **Android (Chrome):** open the app link → **⋮** menu → **Install app** (or **Add to Home screen**).
* **iPhone (Safari):** open the app link → **Share** → **Add to Home Screen**.

Open it from the new icon, sign in, then **Settings → Restore a backup** and choose
`fortnight-shop-backup-2026-11-11.json` to bring over the list from Claude. Do this on one phone only.

## 4. Second phone

On the first phone: **Settings → Set up another phone → Copy link**. Send it to the second phone and open it
in Chrome or Safari, sign in with the same email and password, then install it the same way.
Tick "Include this phone's Claude key" first if both phones should read photos.

## 5. Claude features

**Settings → Claude:** paste an API key from **platform.claude.com → API keys** (add some credit under Billing).
It's stored on that phone only. Without a key, the list, recipes, sync and aisles all still work.
Only photo or link reading and price estimates are hidden.

## Updating

The app's code is `src/list.html` (the same list as the claude.ai version) plus `standalone.js`.
After a change, run `python3 build.py` and push. Phones pick up the new version the next time
they open the app with signal.
