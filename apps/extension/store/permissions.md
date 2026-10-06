# Permissions

One sentence for each permission and host, as the store asks for a justification.

## Permissions

- activeTab: lets the Fill button in the toolbar work on the page you are looking at, only after you click it.
- scripting: runs the fill on that page after you click Fill.
- storage: keeps your Cello address and token, and whether Cello is paused, on this computer.
- tabs: opens the next application in a window of its own while Send for me is on, and reads the address of that one tab to check it is the application Cello expects.
- alarms: the five minute timer that tells Cello this browser is open and, when Send for me is on, asks for the next application to send.
- offscreen: keeps the extension running while an application is being sent, so the browser does not stop it halfway.

## Hosts

- https://boards.greenhouse.io/*, https://job-boards.greenhouse.io/*: Greenhouse hosted application forms.
- https://jobs.lever.co/*: Lever hosted application forms.
- https://jobs.ashbyhq.com/*: Ashby hosted application forms.
- Your Cello address (https://cello-two.vercel.app/*): where the extension asks for answers and reports what happened. Only this address may hand the extension its token.
- http://127.0.0.1/* and http://localhost/*: a Cello you run on your own computer, and a model on your own computer that Cello can use to write drafts.

The extension does not ask for access to all sites and does not load code from anywhere.
