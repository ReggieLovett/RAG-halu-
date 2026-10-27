# Halu Chat

A simple ChatGPT-style dashboard built with Next.js and Groq.

## Run locally

1. Install Node.js 18.17 or newer.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a file named `.env.local` in the project root and add your Groq key:

   ```env
   GROQ_API_KEY=gsk_your_key_here
   ```

   Keep this key in `.env.local`; never expose it in client-side code or commit it to Git.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

The browser sends messages to the local `/api/chat` route. That server-side route calls Groq using the `openai/gpt-oss-20b` model, so your API key is never sent to the browser. Restart the dev server after changing `.env.local`.