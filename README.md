# Terrance's Playground

Welcome to my little corner of the internet.

## Who am I?

I'm Terrance — a tuition teacher by day, and a self-teaching programmer by night.

I started this website because I wanted a space to document my learning, my thoughts, and the things I build along the way.
It's messy, it's imperfect, and that's exactly how I like it.

## What's this site about?

[terrancehah.com](https://terrancehah.com) is a collection of my thoughts, articles, and projects.

This is where I:

- **Write articles** about things that matter to me — education, technology, writing, and nature
- **Build projects** that help me learn new skills and solve problems
- **Play around** with ideas that spark my curiosity

## The Journey

I studied International Business, then found myself in education.
Working with students made me realize how broken some parts of our education system are.
I decided to learn programming, and I hope to help kids embrace technology as a tool for learning, not just entertainment.

## Tech Stack

This site is built with:

- HTML, CSS, JavaScript
- Python and FastAPI for backend experiments
- Hand-written CSS plus a pre-generated utility stylesheet (no live Tailwind build step)
- Hosted on Vercel

## Design and UI

The site's design context lives in [`.impeccable.md`](./.impeccable.md),
the implementation map in [`docs/site-design.md`](./docs/site-design.md),
and there's a public visual guide at
[my-website-style-guide](https://terrancehah.com/articles/my-website-style-guide)
([source](./articles/my-website-style-guide.html)).

Static regression checks (no server needed) live in `tests/` — see the
"Verification" section of `docs/site-design.md` for the commands.

## Local Development

There is no build step — the main site is static; serve the folder over
HTTP with any static file server (pages reference root-absolute assets,
so opening files directly won't work).

A legacy `npm run dev` launcher exists for the persona generator
experiment; it is intended to expose:

- Static site on `http://localhost:3000`
- Persona generator at `http://localhost:3000/projects/persona`

It may require the Python API setup below and isn't needed for the main
site — verify API setup first, and don't launch it automatically.

```bash
npm run dev
```

First time setup:

```bash
# Install Node dependencies
npm install

# Set up Python environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Create .env file with your OpenAI API key
echo "OPENAI_API_KEY=your_key_here" > .env
```

## Contact

Find me on:

- [LinkedIn](https://linkedin.com/in/terrancehah)
- [GitHub](https://github.com/terrancehah)
- [Instagram](https://instagram.com/terrancehah)
- [X (Twitter)](https://x.com/terrance_hah)

## A Note

This website is a constant work in progress.
Some things might be broken, some experiments might fail, and some ideas might not make sense.
Please do not hesitate to reach out if you have any questions or suggestions.

If you're reading this, thank you for being part of the journey.

---

**Last updated: October 2026**
