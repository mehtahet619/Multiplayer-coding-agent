# Supabase setup

## 1. Create the project
Create a project in the Supabase dashboard. Use a strong database password and keep it private. Configure the frontend and API with the project URL.

## 2. Apply the database schema
From the repository root, install the Supabase CLI, authenticate, link the project, and apply migrations:

```sh
npx supabase login
npx supabase link --project-ref duzlokypnhcmfirlrnsi
npx supabase db push
```

Review the migration before applying it to any database containing existing data. The initial migration creates profiles, sessions, instructions, durable activity events, indexes, a profile trigger, and row-level security policies.

## 3. Configure Google sign-in
In Supabase Dashboard → Authentication → Sign In / Providers → Google, enable Google and enter the OAuth client ID and secret from Google Cloud Console. Add the Supabase callback URL displayed in the provider settings to the Google OAuth client's authorized redirect URIs.

In Authentication → URL Configuration, set the production Site URL to the deployed frontend URL and add the local and production frontend URLs to Redirect URLs.

## 4. Environment variables
Frontend (Vite):
- `VITE_SUPABASE_URL`: project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY`: publishable key only
- `VITE_API_URL`: deployed API URL

API (Render environment):
- `SUPABASE_URL`: project URL
- `SUPABASE_PUBLISHABLE_KEY`: the same publishable key used by the frontend. The API forwards each authenticated user JWT to Supabase so row-level security applies; do not configure a service-role key for this setup.

Never put a secret/service-role key in any `VITE_*` variable, source code, repository, issue, or logs. Never paste secrets into chat.

## Security and rollout status
The application branch now adds Google OAuth UI, bearer-token validation, owner checks for API routes and Socket.IO joins, and database-backed sessions, instructions, and events. Apply the migration before deploying that branch. Google sign-in also requires the Google provider credentials and redirect URLs to be configured in Supabase. Build CI must pass, and live auth/database checks must be completed before calling the rollout production-ready.
