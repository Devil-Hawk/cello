# Privacy

This extension handles personal information: the content of job application forms and what you answer on them.

- What it reads: the visible fields of an application form (their labels, types and options) when you click Fill or when Send for me runs, and the confirmation text a site shows after you apply.
- Where it goes: only to your own Cello account, at the address in the extension's options. It is not sent to anyone else.
- What it never reads back: passwords, human check fields, hidden fields, and your answers to questions about gender, ethnicity, disability, veteran status, pay, work authorization or consent. For those, Cello only records that you answered.
- What it stores in the browser: your Cello address, your token, whether Cello is paused, and, if you set them in options, a relay token and the name of a model on this computer.
- Models on this computer: only if you set them up in options, Cello can ask your own Ollama or LM Studio, on this computer and nowhere else, to sort or write text for your account. The request comes from your Cello account and goes to that program only. The reply goes back to your Cello account. The extension refuses any address that is not this computer.
- A model in this browser: only if you turn on Run small steps in this browser, the extension downloads a small language model, including its compiled model library, from the model's host the first time it is used, and runs it here. Nothing you type is sent to that host.
- What it does not do: it does not sell or share data, it does not run scripts loaded from the internet, it does not track your browsing, and it does not read pages outside the application hosts you can see in the permissions.

To remove everything, disconnect the extension in Cello and remove it from the browser.
