// Habilidades de alto nivel del bot
const { goals } = require('mineflayer-pathfinder')

const HOSTILES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'spider', 'cave_spider', 'silverfish', 'endermite',
  'creeper', 'witch', 'slime', 'magma_cube', 'blaze', 'ghast',
  'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'illusioner',
  'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'elder_guardian',
  'phantom', 'breeze', 'shulker', 'enderman'
])

// de los que hay que HUIR, no pelear
const FLEE = new Set(['creeper', 'warden', 'ghast', 'elder_guardian', 'ravager'])

const MATERIALS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']


// lo que uno dice -> el nombre tecnico del bloque
const ALIAS = {
  madera: 'oak_log', tronco: 'oak_log', arbol: 'oak_log', roble: 'oak_log',
  piedra: 'stone', roca: 'stone', tierra: 'dirt', arena: 'sand', grava: 'gravel',
  carbon: 'coal_ore', hierro: 'iron_ore', oro: 'gold_ore', diamante: 'diamond_ore',
  diamantes: 'diamond_ore', cobre: 'copper_ore', redstone: 'redstone_ore',
  lapis: 'lapis_ore', esmeralda: 'emerald_ore', obsidiana: 'obsidian',
  arcilla: 'clay', nieve: 'snow_block', hielo: 'ice', cactus: 'cactus',
  calabaza: 'pumpkin', melon: 'melon', trigo: 'wheat', cana: 'sugar_cane',
  tabla: 'oak_planks', tablas: 'oak_planks', palo: 'stick', palos: 'stick',
  pico: 'stone_pickaxe', espada: 'stone_sword', hacha: 'stone_axe',
  pala: 'stone_shovel', antorcha: 'torch', antorchas: 'torch',
  mesa: 'crafting_table', horno: 'furnace', cofre: 'chest', cama: 'red_bed'
}

const traducir = n => ALIAS[String(n || '').toLowerCase()] || n

function mcd (bot) { return require('minecraft-data')(bot.version) }

function dist (bot, e) { return e.position.distanceTo(bot.entity.position) }

function esHostil (e) {
  if (!e || !e.name || e.type === 'player') return false
  return HOSTILES.has(e.name) || e.type === 'hostile'
}

function nearestHostile (bot, range = 16) {
  return bot.nearestEntity(e => esHostil(e) && dist(bot, e) <= range) || null
}

// lista de todo lo hostil ordenado por distancia
function hostilesCerca (bot, range = 20) {
  return Object.values(bot.entities)
    .filter(e => esHostil(e) && dist(bot, e) <= range)
    .sort((a, b) => dist(bot, a) - dist(bot, b))
}

const ARQUEROS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'illusioner'])

// ---------- movimiento ----------

async function irA (bot, x, y, z, range = 1) {
  return bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
}

async function huirDe (bot, entity, radio = 16) {
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(entity, radio)), true)
}

// ---------- recolectar ----------

async function conseguir (bot, nombre, cantidad = 1, maxDistance = 32) {
  const data = mcd(bot)
  nombre = traducir(nombre)
  const info = data.blocksByName[nombre]
  if (!info) throw new Error(`no conozco el bloque ${nombre}`)

  let total = contarItem(bot, nombre)
  const meta = total + cantidad
  let vueltas = 0

  while (contarItem(bot, nombre) < meta && vueltas < cantidad * 3) {
    vueltas++
    const posiciones = bot.findBlocks({ matching: info.id, maxDistance, count: 8 })
    if (!posiciones.length) throw new Error(`no hay ${nombre} en ${maxDistance} bloques`)
    const bloques = posiciones.map(p => bot.blockAt(p)).filter(Boolean)
    try {
      await bot.collectBlock.collect(bloques[0], { ignoreNoPath: true })
    } catch (e) {
      if (/no path|Took to long|timeout/i.test(e.message)) continue
      throw e
    }
  }
  return contarItem(bot, nombre)
}

// talar un arbol entero (troncos conectados hacia arriba)
async function talar (bot, cantidad = 16) {
  const data = mcd(bot)
  const ids = Object.keys(data.blocksByName)
    .filter(n => n.endsWith('_log'))
    .map(n => data.blocksByName[n].id)

  let cortados = 0
  while (cortados < cantidad) {
    const pos = bot.findBlocks({ matching: ids, maxDistance: 48, count: 12 })
    if (!pos.length) throw new Error('no veo arboles cerca')
    const bloques = pos.map(p => bot.blockAt(p)).filter(Boolean)
    try {
      await bot.collectBlock.collect(bloques.slice(0, 8), { ignoreNoPath: true })
      cortados += 8
    } catch (e) {
      if (/no path|Took to long|timeout/i.test(e.message)) { cortados += 1; continue }
      throw e
    }
  }
  return cortados
}

function contarItem (bot, nombre) {
  return bot.inventory.items()
    .filter(i => i.name === nombre)
    .reduce((a, i) => a + i.count, 0)
}

// ---------- crafteo ----------

async function mesaCerca (bot, colocar = true) {
  const data = mcd(bot)
  let mesa = bot.findBlock({ matching: data.blocksByName.crafting_table.id, maxDistance: 8 })
  if (mesa) {
    if (mesa.position.distanceTo(bot.entity.position) > 3.5) {
      await irA(bot, mesa.position.x, mesa.position.y, mesa.position.z, 2)
    }
    return mesa
  }
  if (!colocar) return null

  // no hay: la craftea y la pone
  let item = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!item) {
    try { await craftear(bot, 'crafting_table', 1, false) } catch (e) { return null }
    item = bot.inventory.items().find(i => i.name === 'crafting_table')
  }
  if (!item) return null

  const suelo = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  if (!suelo || suelo.name === 'air') return null
  await bot.equip(item, 'hand')
  try {
    await bot.placeBlock(suelo, { x: 0, y: 1, z: 0 })
  } catch (e) { /* a veces choca con el propio cuerpo */ }
  return bot.findBlock({ matching: data.blocksByName.crafting_table.id, maxDistance: 6 })
}

async function craftear (bot, nombre, cantidad = 1, usarMesa = true) {
  const data = mcd(bot)
  nombre = traducir(nombre)
  const item = data.itemsByName[nombre]
  if (!item) throw new Error(`no conozco el item ${nombre}`)

  // primero sin mesa (inventario 2x2)
  let recetas = bot.recipesFor(item.id, null, cantidad, null)
  let mesa = null

  if (!recetas.length && usarMesa) {
    mesa = await mesaCerca(bot)
    if (mesa) recetas = bot.recipesFor(item.id, null, cantidad, mesa)
  }
  if (!recetas.length) throw new Error(`no me alcanzan los materiales para ${nombre}`)

  await bot.craft(recetas[0], cantidad, mesa || undefined)
  return contarItem(bot, nombre)
}

// craftea el mejor equipo posible con lo que tiene
async function equiparse (bot) {
  const hechos = []
  const tipos = ['pickaxe', 'sword', 'axe', 'shovel']

  // asegura tablones y palos
  for (const base of ['stick']) {
    if (contarItem(bot, base) < 4) {
      try { await craftear(bot, base, 1) } catch (e) { /* sin madera */ }
    }
  }

  for (const tipo of tipos) {
    const yaTiene = bot.inventory.items().some(i => i.name.endsWith('_' + tipo))
    if (yaTiene) continue
    for (const mat of MATERIALS) {
      try {
        await craftear(bot, `${mat}_${tipo}`, 1)
        hechos.push(`${mat}_${tipo}`)
        break
      } catch (e) { /* siguiente material */ }
    }
  }

  // armadura
  for (const pieza of ['helmet', 'chestplate', 'leggings', 'boots']) {
    const yaTiene = bot.inventory.items().some(i => i.name.endsWith('_' + pieza))
    if (yaTiene) continue
    for (const mat of ['diamond', 'iron', 'golden', 'leather']) {
      try {
        await craftear(bot, `${mat}_${pieza}`, 1)
        hechos.push(`${mat}_${pieza}`)
        break
      } catch (e) { /* siguiente */ }
    }
  }

  if (bot.armorManager) bot.armorManager.equipAll()
  return hechos
}

// ---------- cofres ----------

async function guardarEnCofre (bot, mantener = ['pickaxe', 'sword', 'axe', 'shovel', 'torch', 'bread', 'cooked']) {
  const data = mcd(bot)
  const ids = [data.blocksByName.chest.id, data.blocksByName.barrel?.id].filter(Boolean)
  const bloque = bot.findBlock({ matching: ids, maxDistance: 24 })
  if (!bloque) throw new Error('no veo ningun cofre cerca')

  await irA(bot, bloque.position.x, bloque.position.y, bloque.position.z, 2)
  const cofre = await bot.openContainer(bot.blockAt(bloque.position))
  let n = 0
  for (const item of bot.inventory.items()) {
    if (mantener.some(k => item.name.includes(k))) continue
    try { await cofre.deposit(item.type, null, item.count); n += item.count } catch (e) { break }
  }
  cofre.close()
  return n
}

// ---------- dormir ----------

async function dormir (bot) {
  const data = mcd(bot)
  const ids = Object.keys(data.blocksByName).filter(n => n.endsWith('_bed')).map(n => data.blocksByName[n].id)
  const cama = bot.findBlock({ matching: ids, maxDistance: 32 })
  if (!cama) throw new Error('no hay cama cerca')
  await irA(bot, cama.position.x, cama.position.y, cama.position.z, 2)
  await bot.sleep(bot.blockAt(cama.position))
  return true
}

// ---------- antorchas ----------

async function ponerAntorcha (bot) {
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) return false
  const suelo = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  if (!suelo || suelo.name === 'air' || suelo.name.includes('water')) return false
  const arriba = bot.blockAt(bot.entity.position)
  if (arriba && arriba.name !== 'air') return false
  await bot.equip(torch, 'hand')
  try { await bot.placeBlock(suelo, { x: 0, y: 1, z: 0 }); return true } catch (e) { return false }
}

module.exports = {
  HOSTILES, FLEE, MATERIALS, ALIAS, traducir,
  irA, huirDe, nearestHostile, hostilesCerca, esHostil, ARQUEROS, dist,
  conseguir, talar, contarItem,
  craftear, mesaCerca, equiparse,
  guardarEnCofre, dormir, ponerAntorcha
}
