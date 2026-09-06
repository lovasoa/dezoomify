# Privacy

dezoomify-ng is a free and open source project, built by volunteers and funded
by donations. It has no investors, no advertising, and no paid data business.
Nobody in this project makes money from knowing what you look at, so we have
designed everything to make sure we cannot, even by accident. This page
explains, in plain words, exactly what happens to your information when you
use dezoomify-ng.

## What dezoomify-ng is, in one paragraph

Dezoomify saves a full-resolution copy of a zoomable image — the kind of very
large picture that museum and library websites show in small pieces — into one
ordinary image file. You give it the address of a page that shows such an
image, it figures out where the picture pieces live, downloads them, and
glues them together on your own device. That is all it does.

## Our privacy guarantees

**Your pictures never pass through our computers.** The image pieces travel
directly from the museum's website to your device, and your finished file is
assembled on your device. Our server is never in the middle of that.

**There is no backend that processes your personal information.** The project
runs one small helper server, with one narrow task: when a website's own rules
block your browser from reading an image's description (the technical list of
where the picture pieces are), the helper fetches that description for you.
It works only for public pages, never handles your picture data, and never
sees any login information.

**There are no accounts and no sign-up.** We do not know who you are, and we
have nowhere to store a profile about you even if we wanted one.

**We do not track you.** Dezoomify has no analytics, no advertising tools, no
traffic counters that record who visited which page, and no crash reports.
When something goes wrong, the error message shown to you is built from
information already on your device.

**The pages you save stay private.** The addresses of the pages you open, the
titles of those pages, and the pictures themselves are never included in any
error text, any report, or any log of ours.

**The helper server keeps minimal logs.** When it helps your browser read a
public image description, its log records that a request happened and a short
category code describing why. It does not record the address of the picture
page you were looking at.

**Support information is under your control.** If something fails and you want
help, dezoomify can prepare a technical summary. That summary is automatically
cleaned of anything private, and nothing is sent anywhere unless you
explicitly choose to copy it and send it yourself.

## The browser extension

The browser extension adds dezoomify to Firefox or Chrome so it can work
inside the page you are looking at. Two things deserve explanation.

**It only looks when you ask.** The extension never reads pages in the
background or while you browse. It examines a page only after you click it,
for that one page, and stops as soon as it is done.

**It can use your existing logins, inside your own browser.** Some pictures
are only visible to members — you may need to be signed in to the museum's
site to see them. The extension works with the login that your browser
already has, so you do not have to type your password anywhere new. All of
this happens inside your browser: the project never receives your password,
your username, or your session.

### Cookies and private login information

Cookies are small pieces of information a website stores in your browser to
remember that you are signed in. They are the most sensitive thing dezoomify
touches, so they have their own rules:

- Cookies and sign-in details are used only inside your browser, for the site
  you asked dezoomify to work on, and only for a job you started yourself.
- They are never sent to the project's server, which by design cannot receive
  them.
- They are never written into the finished image file, into logs, or into any
  report.
- If you move a job to the desktop app to save a very large picture, cookies
  are transferred only if a prompt explicitly lists which sites they are for
  and where they are going, and you approve it. That approval applies to that
  one job only; it is never remembered for future jobs. If you decline, the
  job simply stays in your browser.
- Transferred cookies are not kept. Once the job ends, references to them are
  dropped.

## Where to learn more

The technical rules behind these promises are in [Security](security.md);
step-by-step instructions for each app are in the [user
documentation](user/README.md).
