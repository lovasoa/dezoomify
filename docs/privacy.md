# Privacy

dezoomify is free and open source, built by volunteers and funded by
donations. There are no investors, no advertisers, and no data business
behind it. Nobody here makes money from knowing what you look at, and
we've built the whole thing so that we can't find out, even by accident.
Here's what happens to your information when you use it, in plain words.

## What dezoomify does, in one paragraph

Museums and libraries often show very large pictures in small pieces.
Dezoomify saves the whole picture, at full resolution, as one ordinary
image file. You give it the address of a page showing such a picture. It
works out where the pieces live, fetches them, and glues them together on
your own device. That is all it does.

## Our promises

**Your pictures never pass through our computers.** The pieces travel
straight from the museum's website to your device, and the finished file
is assembled there. Our server is never in the middle.

**No backend processes your personal information.** We do run one small
helper server, and it has one narrow job: when a website's own rules stop
your browser from reading an image's description (the technical list of
where the picture pieces are), the helper fetches that description for
you. It only works on public pages, it never touches your picture data,
and it never sees anything you'd log in with.

**There are no accounts and nothing to sign up for.** We don't know who
you are, and we'd have nowhere to keep a profile on you even if we wanted
one.

**We don't track you.** Dezoomify has no analytics, no advertising tools,
no traffic counters noting who visited which page, and no crash reports.
When something goes wrong, the error message you see is assembled from
information already on your device.

**What you look at stays yours.** The addresses of the pages you open,
their titles, and the pictures themselves never end up in any error text,
any report, or any log of ours.

**The helper server keeps almost no logs.** When it fetches a public
image description for you, its log records that a request happened, and a
short category code saying why. It never records the address of the page
you were on.

**Getting help stays in your hands.** If something fails and you want
support, dezoomify can prepare a technical summary. Anything private gets
cleaned out of it automatically, and nothing is sent anywhere unless you
choose to copy it and send it yourself.

## The browser extension

The extension adds dezoomify to Firefox or Chrome so that it can work
inside the page you're looking at. Two things about it are worth knowing.

**It only looks when you ask.** The extension never reads pages in the
background or while you browse. It examines a page only after you click,
only that one page, and it stops as soon as it's done.

**It can use the logins your browser already has.** Some pictures are
visible to members only, so you may need to be signed in to the museum's
site to see them. The extension works with the login your browser already
holds, so you never have to type your password anywhere new. All of this
happens inside your browser: the project never receives your password,
your username, or your session.

### Cookies and private login information

Cookies are the small notes a website keeps in your browser so it
remembers you're signed in. They're the most sensitive thing dezoomify
ever touches, so they get their own rules:

- Cookies and sign-in details are used only inside your browser, only for
  the site you asked dezoomify to work on, and only for a job you started
  yourself.
- They're never sent to the project's server, which by design can't
  receive them.
- They're never written into the finished image file, into logs, or into
  any report.
- If you move a job to the desktop app to save a very large picture,
  cookies come along only after a prompt tells you which sites they're for
  and where they're going, and you approve it. That approval covers that
  one job only, and it's never remembered for future jobs. If you decline,
  the job simply stays in your browser.
- Transferred cookies aren't kept. Once the job ends, references to them
  are dropped.

## Where to learn more

The technical rules behind these promises are in [Security](security.md),
and step-by-step instructions for each app are in the [user
documentation](user/README.md).
