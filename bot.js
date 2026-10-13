const fs = require('fs')
const path = require('path')

// .env sencillo: la API key va ahi, nunca en el codigo
try {
  for (const linea of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
} catch (e) { /* sin .env: se usa ollama */ }
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const armorManager = require('mineflayer-armor-manager')
const toolPlugin = require('mineflayer-tool').plugin
const collectBlock = require('mineflayer-collectblock').plugin
const S = require('./skills')
const { crearCerebro } = require('./brain')

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USER = process.env.MC_USER || 'Tulpa'
const VERSION = process.env.MC_VERSION || '1.21.11'
const FIFO = path.join(__dirname, 'cmd.fifo')

let cerebro = null
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION, auth: 'offline' })

bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)
bot.loadPlugin(armorManager)
bot.loadPlugin(toolPlugin)
bot.loadPlugin(collectBlock)

// auto-eat es ESM puro: carga diferida
import('mineflayer-auto-eat').then(m => {
  bot.loadPlugin(m.loader)
  // loadPlugin se difiere hasta que el bot puede inyectar: hay que esperarlo
  const esperar = setInterval(() => {
    if (!bot.autoEat) return
    clearInterval(esperar)
    Object.assign(bot.autoEat.opts, {
      priority: 'foodPoints',
      minHunger: 16,
      bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew']
    })
    bot.autoEat.enableAuto()
    log('auto-eat activo')
  }, 500)
  setTimeout(() => clearInterval(esperar), 30000)
}).catch(e => log('auto-eat fallo:', e.message))

// ---------- estado ----------
const state = {
  owner: null,
  following: null,
  auto: true,        // supervivencia automatica
  defender: true,    // pelea con hostiles
  busy: null,        // tarea en curso
  emergency: false,
  lastTorch: 0,
  saltoMio: false
}

const say = msg => { log('>>', msg); bot.chat(String(msg).slice(0, 250)) }

// ---------- arranque ----------
bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version)
  const moves = new Movements(bot, mcData)
  moves.canDig = false          // cavando tardaba siglos donde bastaba saltar
  moves.allowParkour = true
  moves.allowSprinting = true
  moves.allow1by1towers = false
  moves.canOpenDoors = true
  moves.blocksToAvoid.add(mcData.blocksByName.lava.id)
  moves.blocksToAvoid.add(mcData.blocksByName.fire.id)
  moves.blocksToAvoid.add(mcData.blocksByName.magma_block.id)
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.thinkTimeout = 3000
  bot.pathfinder.tickTimeout = 20      // mas ms por tick de busqueda = reacciona antes

  log(`conectado como ${bot.username} en ${HOST}:${PORT} (${bot.version})`)
  say('Ya llegue')
  openFifo()
  setInterval(tick, 250)

  // sin credenciales no se enciende el cerebro: los modelos locales de esta
  // maquina no soportan tool calling, asi que solo quedan los comandos con !
  const hayCerebro = !!process.env.ANTHROPIC_API_KEY || !!process.env.MC_BRAIN
  cerebro = !hayCerebro ? null : crearCerebro(bot, {
    decir: say,
    equiparArma,
    seguir: (jugador) => {
      state.following = jugador
      const e = bot.players[jugador]?.entity
      if (e) bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
    },
    parar: () => {
      state.following = null
      state.busy = null
      bot.pvp.stop()
      bot.pathfinder.setGoal(null)
    }
  }, log)
  log(cerebro ? `cerebro: ${cerebro.backend} (${cerebro.modelo})` : 'cerebro apagado (falta ANTHROPIC_API_KEY en .env) — solo comandos con !')
  setTimeout(() => { bot.armorManager?.equipAll(); equiparArma() }, 1500)
})

// ---------- loop de supervivencia ----------
async function tick () {
  if (!state.auto || !bot.entity) return
  try {
    const pos = bot.entity.position

    // 1. lava / fuego en los pies
    const pies = bot.blockAt(pos)
    if (pies && (pies.name.includes('lava') || pies.name === 'fire')) {
      state.emergency = true
      const agua = bot.findBlock({ matching: b => b.name === 'water', maxDistance: 24 })
      if (agua) await S.irA(bot, agua.position.x, agua.position.y, agua.position.z, 1)
      else bot.setControlState('jump', true), setTimeout(() => bot.setControlState('jump', false), 600)
      state.emergency = false
      return
    }

    // 2. ahogandose (solo suelto el salto si lo puse yo: pisarselo a
    //    pathfinder es lo que lo dejaba atascado en cada bloque)
    if (bot.oxygenLevel !== undefined && bot.oxygenLevel < 12) {
      state.saltoMio = true
      bot.setControlState('jump', true)
      bot.look(bot.entity.yaw, -Math.PI / 2, true)
      return
    }
    if (state.saltoMio) {
      state.saltoMio = false
      bot.setControlState('jump', false)
    }

    // 3. creeper / warden cerca -> huir sin pensarlo
    const peligro = bot.nearestEntity(e =>
      S.FLEE.has(e.name) && S.dist(bot, e) < (e.name === 'creeper' ? 7 : 24))
    if (peligro) {
      state.emergency = true
      bot.pvp.stop()
      log(`huyendo de ${peligro.name} a ${S.dist(bot, peligro).toFixed(1)}`)
      await S.huirDe(bot, peligro, peligro.name === 'creeper' ? 12 : 32)
      setTimeout(() => { state.emergency = false }, 1500)
      return
    }

    // 4. vida critica -> retirada
    if (bot.health <= 6) {
      const amenaza = S.nearestHostile(bot, 12)
      if (amenaza) {
        state.emergency = true
        bot.pvp.stop()
        await S.huirDe(bot, amenaza, 24)
        setTimeout(() => { state.emergency = false }, 2000)
        return
      }
    }

    if (state.emergency) return

    // 5. defensa (los arqueros pegan de lejos: hay que verlos de lejos)
    if (state.defender && !bot.pvp.target && bot.health > 8) {
      const hostil = S.hostilesCerca(bot, 20)
        .find(e => !S.FLEE.has(e.name) &&
          S.dist(bot, e) <= (S.ARQUEROS.has(e.name) ? 20 : 10))
      if (hostil) {
        await equiparArma()
        log(`peleando con ${hostil.name} a ${S.dist(bot, hostil).toFixed(1)}`)
        bot.pvp.attack(hostil)
      }
    }

    // 6. antorcha si esta oscuro (cada 6s como mucho)
    if (Date.now() - state.lastTorch > 6000 && !state.busy) {
      const luz = bot.blockAt(bot.entity.position)?.light ?? 15
      if (luz < 7) { state.lastTorch = Date.now(); await S.ponerAntorcha(bot) }
    }

    // 7. seguir al owner
    if (state.following && !bot.pvp.target && !state.busy) {
      const p = bot.players[state.following]?.entity
      if (p && !(bot.pathfinder.goal instanceof goals.GoalFollow)) {
        bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
      }
    }
  } catch (e) {
    if (!/goal|path/i.test(e.message)) log('tick:', e.message)
  }
}

async function equiparArma () {
  const orden = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe']
  for (const n of orden) {
    const it = bot.inventory.items().find(i => i.name === n)
    if (it) { try { await bot.equip(it, 'hand') } catch (e) {} ; return n }
  }
  return null
}

// ---------- tareas ----------
async function tarea (nombre, fn) {
  if (state.busy) return say(`Espera, ando en ${state.busy}`)
  state.busy = nombre
  state.following = null
  try {
    await fn()
  } catch (e) {
    say(`Se me complico: ${e.message}`)
    log('tarea', nombre, 'fallo:', e.stack?.split('\n')[0])
  } finally {
    state.busy = null
  }
}

function jugadorObjetivo () {
  if (state.owner && bot.players[state.owner]?.entity) return bot.players[state.owner].entity
  return bot.nearestEntity(e => e.type === 'player')
}

// ---------- comandos ----------
const AYUDA = 'ven / sigueme / para / mina <bloque> [n] / tala [n] / craft <item> [n] / equipate / guarda / duerme / ataca <quien> / defiende on|off / ir x y z / inv / donde / salir'

async function handle (raw, from) {
  const txt = String(raw).trim()
  if (from) state.owner = from
  const [cmd, ...rest] = txt.toLowerCase().split(/\s+/)
  const arg = rest.join(' ')

  switch (cmd) {
    case 'ven': case 'aqui': {
      state.following = null
      const p = jugadorObjetivo()
      if (!p) return say('No te veo')
      return tarea('ir donde ti', async () => {
        await S.irA(bot, p.position.x, p.position.y, p.position.z, 2)
        say('Aqui toy')
      })
    }

    case 'sigueme': case 'sigue': {
      const p = jugadorObjetivo()
      if (!p) return say('No te veo')
      state.following = p.username || state.owner
      bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
      return say('Voy detras tuyo')
    }

    case 'para': case 'quieto':
      state.following = null
      state.busy = null
      bot.pvp.stop()
      bot.pathfinder.setGoal(null)
      bot.stopDigging?.()
      return say('Ok')

    case 'mina': case 'consigue': {
      if (!rest[0]) return say('Que mino?? ej: !mina madera 10')
      const n = parseInt(rest[1]) || 1
      return tarea(`minar ${rest[0]}`, async () => {
        say(`Voy por ${n} de ${rest[0]}`)
        const total = await S.conseguir(bot, rest[0], n)
        say(`Listo, tengo ${total} de ${rest[0]}`)
      })
    }

    case 'tala': case 'madera': {
      const n = parseInt(rest[0]) || 16
      return tarea('talar', async () => {
        say(`Voy por madera`)
        await S.talar(bot, n)
        const logs = bot.inventory.items().filter(i => i.name.endsWith('_log')).reduce((a, i) => a + i.count, 0)
        say(`Traigo ${logs} troncos`)
      })
    }

    case 'craft': case 'craftea': {
      if (!rest[0]) return say('Que crafteo?? ej: !craft pico')
      const n = parseInt(rest[1]) || 1
      return tarea(`craftear ${rest[0]}`, async () => {
        const total = await S.craftear(bot, rest[0], n)
        say(`Hecho, tengo ${total} de ${rest[0]}`)
      })
    }

    case 'equipate': case 'equipar':
      return tarea('equiparme', async () => {
        const hechos = await S.equiparse(bot)
        say(hechos.length ? `Me hice: ${hechos.join(', ')}` : 'No me alcanzo para nada nuevo')
      })

    case 'guarda':
      return tarea('guardar', async () => {
        const n = await S.guardarEnCofre(bot)
        say(`Guarde ${n} items`)
      })

    case 'duerme':
      return tarea('dormir', async () => {
        await S.dormir(bot)
        say('Buenas noches')
      })

    case 'ataca': {
      if (!rest[0]) return say('A quien?? ej: !ataca zombie')
      const objetivo = bot.nearestEntity(e =>
        (e.username && e.username.toLowerCase() === rest[0]) ||
        (e.name && e.name.toLowerCase() === rest[0]))
      if (!objetivo) return say(`No veo a ${rest[0]}`)
      await equiparArma()
      bot.pvp.attack(objetivo)
      return say(`Voy por ${rest[0]}`)
    }

    case 'defiende':
      state.defender = rest[0] !== 'off'
      return say(`Defensa ${state.defender ? 'encendida' : 'apagada'}`)

    case 'auto':
      state.auto = rest[0] !== 'off'
      return say(`Automatico ${state.auto ? 'encendido' : 'apagado'}`)

    case 'ir': {
      const [x, y, z] = rest.map(Number)
      if ([x, y, z].some(isNaN)) return say('Uso: ir <x> <y> <z>')
      return tarea('caminar', async () => {
        say(`Yendo a ${x} ${y} ${z}`)
        await S.irA(bot, x, y, z, 1)
        say('Llegue')
      })
    }

    case 'inv': {
      const items = bot.inventory.items()
      return say(items.length ? items.map(i => `${i.name} x${i.count}`).join(', ') : 'Ando vacio')
    }

    case 'donde': case 'vida': {
      const p = bot.entity.position
      return say(`x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} z=${p.z.toFixed(0)} | vida ${bot.health} comida ${bot.food} | ${state.busy || 'libre'}`)
    }

    case 'tira': case 'dame': {
      if (!rest[0]) return say('Que te doy?? ej: !dame madera')
      const item = bot.inventory.items().find(i => i.name.includes(rest[0]))
      if (!item) return say(`No tengo ${rest[0]}`)
      const p = jugadorObjetivo()
      if (p) await bot.lookAt(p.position)
      await bot.tossStack(item)
      return say(`Ahi va ${item.name}`)
    }

    case 'di':
      return bot.chat(txt.slice(3))

    case 'radar': {
      const es = S.hostilesCerca(bot, 32)
      if (!es.length) return say('No veo nada hostil en 32 bloques')
      return say(es.slice(0, 6).map(e => `${e.name} a ${S.dist(bot, e).toFixed(0)}`).join(', '))
    }

    case 'ayuda': case 'help':
      return say(AYUDA)

    case 'salir':
      say('Byeeee')
      return setTimeout(() => bot.quit(), 500)

    default:
      if (from) say(`No entendi. ${AYUDA}`)
  }
}

// ---------- entradas ----------
bot.on('chat', (username, message) => {
  if (username === bot.username) return
  log(`<${username}> ${message}`)
  if (message.startsWith('!')) return handle(message.slice(1), username)
  // lenguaje normal: lo decide el cerebro
  state.owner = username
  if (cerebro) cerebro.responder(username, message)
})

function openFifo () {
  if (!fs.existsSync(FIFO)) {
    try { require('child_process').execSync(`mkfifo ${JSON.stringify(FIFO)}`) } catch (e) { return log('sin fifo:', e.message) }
  }
  const read = () => {
    const s = fs.createReadStream(FIFO)
    let buf = ''
    s.on('data', d => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) { log('fifo:', line); handle(line, null) }
      }
    })
    s.on('end', () => setTimeout(read, 100))
    s.on('error', e => log('fifo err:', e.message))
  }
  read()
  log(`control: echo "ven" > ${FIFO}`)
}

// ---------- eventos ----------
let ultimaVida = 20
bot.on('health', async () => {
  if (bot.health < ultimaVida) {
    log(`golpe: vida ${ultimaVida.toFixed(1)} -> ${bot.health.toFixed(1)}`)
    // devolver el golpe: el culpable es el hostil mas cercano
    if (state.defender && !bot.pvp.target && bot.health > 6 && !state.emergency) {
      const culpable = S.hostilesCerca(bot, 24).find(e => !S.FLEE.has(e.name))
      if (culpable) {
        await equiparArma()
        log(`me pego ${culpable.name}, voy por el`)
        bot.pvp.attack(culpable)
      }
    }
  }
  ultimaVida = bot.health
})
bot.on('death', () => { log('me mataron'); state.busy = null; state.emergency = false })
bot.on('playerCollect', (col, it) => { if (col.username === bot.username) bot.armorManager?.equipAll() })
// diagnostico de empuje: ver si el server nos manda velocidad y si se aplica
// ---------- knockback ----------
// Desde 1.19.4 el server manda damage_event y es el CLIENTE quien aplica el
// empuje. mineflayer no lo hace, asi que reproducimos LivingEntity.knockback()
function aplicarKnockback (origen, fuerza = 0.4) {
  const p = bot.entity.position
  let dx = origen.x - p.x
  let dz = origen.z - p.z
  let d = Math.sqrt(dx * dx + dz * dz)
  if (d < 1e-4) {           // golpe justo encima: empuje en una direccion random
    const a = Math.random() * Math.PI * 2
    dx = Math.cos(a); dz = Math.sin(a); d = 1
  }
  const v = bot.entity.velocity
  v.x = v.x / 2 - (dx / d) * fuerza
  v.z = v.z / 2 - (dz / d) * fuerza
  v.y = bot.entity.onGround ? Math.min(0.4, v.y / 2 + fuerza) : v.y
}

bot._client.on('damage_event', p => {
  if (p.entityId !== bot.entity?.id) return
  // sourceDirectId/CauseId vienen +1 (0 = sin entidad)
  const atacante = bot.entities[p.sourceDirectId - 1] || bot.entities[p.sourceCauseId - 1]
  const origen = atacante?.position || (p.sourcePosition ? p.sourcePosition : null)
  if (!origen) return
  const corriendo = atacante?.metadata?.[0] & 0x08   // bit de sprint
  aplicarKnockback(origen, corriendo ? 0.9 : 0.4)
  log(`kb aplicado desde ${atacante?.username || atacante?.name || 'algo'}`)
})

bot.on('kicked', r => log('kicked:', r))
bot.on('error', e => log('error:', e.message))
bot.on('end', r => { log('desconectado:', r); process.exit(0) })
// ---------- detector de atascos ----------
let ultimaPos = null
let quieto = 0
setInterval(() => {
  if (!bot.entity || !bot.pathfinder?.goal) { quieto = 0; ultimaPos = null; return }
  const p = bot.entity.position
  if (ultimaPos && p.distanceTo(ultimaPos) < 0.12) {
    quieto++
    if (quieto === 4) {   // 2 segundos sin avanzar teniendo a donde ir
      const yaw = bot.entity.yaw
      const frente = bot.blockAt(p.offset(-Math.sin(yaw), 0, -Math.cos(yaw)))
      const arriba = bot.blockAt(p.offset(-Math.sin(yaw), 1, -Math.cos(yaw)))
      log(`ATASCADO en ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} | frente=${frente?.name} arriba=${arriba?.name} | onGround=${bot.entity.onGround}`)
    }
  } else {
    quieto = 0
  }
  ultimaPos = p.clone()
}, 500)

process.on('unhandledRejection', e => log('rejection:', e?.message || e))
