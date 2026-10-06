// Fixture pages for the three hosted-form families, each with a real challenge
// script tag, an invisible challenge frame and the challenge's own inputs, as the
// live forms carry. Pages are built here so each stop cause is one small variation.

export const CHALLENGE_SCRIPT = `<script src="https://js.hcaptcha.com/1/api.js" async defer></script>`
const CHALLENGE_URL = 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'

/** The challenge as it sits on a form that shows no widget: a 1px frame and its inputs. */
export const CHALLENGE_QUIET = `
  ${CHALLENGE_SCRIPT}
  <iframe title="hCaptcha challenge" src="${CHALLENGE_URL}" style="position:absolute;width:1px;height:1px;border:0;opacity:0"></iframe>
  <textarea name="h-captcha-response" style="display:none"></textarea>
  <input type="hidden" name="g-recaptcha-response" value="">
  <input type="hidden" name="cf-turnstile-response" value="">`

/** A challenge a person can see and must solve. */
export const CHALLENGE_VISIBLE = `
  ${CHALLENGE_SCRIPT}
  <iframe title="hCaptcha" src="${CHALLENGE_URL}" style="display:block;width:304px;height:78px;border:1px solid #888"></iframe>
  <textarea name="h-captcha-response" style="display:none"></textarea>`

export const FIELDS_GREENHOUSE = `
  <div><label for="first_name">First name *</label><input id="first_name" name="first_name" type="text" required autocomplete="given-name"></div>
  <div><label for="last_name">Last name *</label><input id="last_name" name="last_name" type="text" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div><label for="linkedin">LinkedIn profile</label><input id="linkedin" name="linkedin" type="url"></div>
  <div><label for="location">Location</label><input id="location" name="location" type="text"></div>
  <div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" accept=".pdf" required></div>
  <div><label for="why">Why do you want to work here?</label><textarea id="why" name="why" rows="4"></textarea></div>
  <div><label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select...</option><option>Woman</option><option>Man</option><option>Decline to answer</option></select></div>
  <div><label><input type="checkbox" name="consent"> I agree to the privacy policy</label></div>`

export const FIELDS_LEVER = `
  <div><label for="name">Full name</label><input id="name" name="name" type="text" required></div>
  <div><label for="email">Email</label><input id="email" name="email" type="email" required></div>
  <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div><label for="org">Current company</label><input id="org" name="org" type="text"></div>
  <div><label for="li">LinkedIn URL</label><input id="li" name="urls[LinkedIn]" type="url"></div>
  <div><label for="resume">Resume/CV</label><input id="resume" name="resume" type="file"></div>
  <div><label for="comments">Additional information</label><textarea id="comments" name="comments"></textarea></div>`

// Ashby wraps each input in its label and gives it no id.
export const FIELDS_ASHBY = `
  <label><span>Name</span><input name="_systemfield_name" type="text" required></label>
  <label><span>Email</span><input name="_systemfield_email" type="email" required></label>
  <label><span>Phone number</span><input name="phone" type="tel"></label>
  <label><span>Resume</span><input name="resume" type="file"></label>
  <label><span>Why do you want to work here?</span><textarea name="why"></textarea></label>`

export interface PageOptions {
  fields?: string
  challenge?: string
  submit?: string
  formAttrs?: string
  /** Markup before the form (page text). */
  before?: string
  /** Inline script, run after the form exists. */
  script?: string
  title?: string
}

export const SUBMIT = `<button type="submit">Submit application</button>`

/** Counts every submit the page lets through, before anything else happens. */
export const COUNT_CLICKS = `
  document.getElementById('application_form').addEventListener('submit', function () {
    navigator.sendBeacon('/__click', 'x');
  });`

export function page(o: PageOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${o.title ?? 'Apply'}</title>
<style>body{font:16px system-ui;margin:24px;max-width:640px}div{margin:8px 0}label{display:block}input,select,textarea{font:inherit}</style>
</head>
<body>
<h1>Software Engineer</h1>
${o.before ?? ''}
<form id="application_form" method="post" action="/__submit" ${o.formAttrs ?? ''}>
${o.fields ?? FIELDS_GREENHOUSE}
${o.challenge ?? CHALLENGE_QUIET}
${o.submit ?? SUBMIT}
</form>
<script>${COUNT_CLICKS}${o.script ?? ''}</script>
</body>
</html>`
}

export function confirmation(noisy = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Thank you</title></head>
<body><h1>Thank you for applying</h1><p>Your application has been submitted.</p>
${noisy ? `<canvas id="n" width="1280" height="720" style="position:fixed;inset:0;z-index:-1"></canvas>
<script>const c=document.getElementById('n'),x=c.getContext('2d'),d=x.createImageData(1280,720);for(let i=0;i<d.data.length;i++)d.data[i]=i%4===3?255:Math.random()*255;x.putImageData(d,0,0);</script>` : ''}
</body></html>`
}

export const CHALLENGE_FRAME = `<!doctype html><html><body><input id="challenge-input" name="challenge-input"><p>Check</p></body></html>`
