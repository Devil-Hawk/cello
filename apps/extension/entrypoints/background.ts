import { browser } from 'wxt/browser'
import { defineBackground } from 'wxt/utils/define-background'
import type { ToWorker } from '../lib/messages'
import { handle, handleExternal } from '../worker/handlers'
import { listenKeepAlive } from '../worker/keepalive'
import { PRESENCE_ALARM, ensureAlarm, presence } from '../worker/presence'
import { recover } from '../worker/send'

// Every listener is registered on the worker's first turn, as manifest v3 needs.
export default defineBackground(() => {
  listenKeepAlive()

  browser.runtime.onInstalled.addListener(() => void ensureAlarm())
  browser.runtime.onStartup.addListener(() => {
    void ensureAlarm()
    void recover()
  })
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PRESENCE_ALARM) void presence()
  })

  // A new token means the first presence call should not wait for the alarm.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.token?.newValue) void presence()
  })

  browser.runtime.onMessage.addListener((msg: ToWorker, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false
    void handle(msg, sender).then(sendResponse)
    return true
  })
  browser.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    void handleExternal(msg, sender).then(sendResponse)
    return true
  })

  void ensureAlarm()
})
