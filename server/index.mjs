import { readSettings } from './config.mjs'
import { createApplication } from './http.mjs'
import { acquireRunnerLock } from './runner-lock.mjs'

function start() {
  const settings = readSettings()
  const release = acquireRunnerLock(settings.dataFile)
  let app
  try {
    app = createApplication(settings)
  } catch (error) {
    release()
    throw error
  }
  const { server, scheduler, leases, pythonTasks, store } = app
  let closing = false

  function stop() {
    if (closing) return
    closing = true
    scheduler.stop()
    const drained = Promise.all([leases.stop(), pythonTasks.stopAll()])
    server.close(() => {
      void drained.finally(() => {
        try { store.close() } finally { release() }
      }).catch(error => {
        console.error('服务关闭失败', error.code || error.name)
        process.exitCode = 1
      })
    })
  }

  server.once('error', error => {
    console.error('服务启动失败', error.code || error.name)
    process.exitCode = 1
    stop()
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop)
  try {
    server.listen(settings.port, settings.host, () => {
      if (closing) return
      const host = settings.host === '::1' ? '[::1]' : settings.host
      console.log(`WorkBuddy 保活平台 ${settings.webOrigin || `http://${host}:${settings.port}`}`)
      scheduler.start()
      leases.start()
    })
  } catch (error) {
    stop()
    throw error
  }
}

try {
  start()
} catch (error) {
  console.error('服务启动失败', error.message)
  process.exitCode = 1
}
