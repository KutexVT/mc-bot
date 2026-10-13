// Herramientas que el modelo puede llamar. Cada una: schema + implementacion.
const S = require('./skills')

function resumenEntorno (bot) {
  const p = bot.entity.position
  const hostiles = S.hostilesCerca(bot, 24)
    .slice(0, 5).map(e => `${e.name} a ${S.dist(bot, e).toFixed(0)}m`)
  const jugadores = Object.values(bot.players)
    .filter(j => j.entity && j.username !== bot.username)
    .map(j => `${j.username} a ${S.dist(bot, j.entity).toFixed(0)}m`)
  const bloque = bot.blockAt(p.offset(0, -1, 0))
  const t = bot.time.timeOfDay
  const hora = t < 12541 ? 'dia' : (t < 23458 ? 'noche' : 'amanece')

  return {
    posicion: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
    vida: bot.health,
    comida: bot.food,
    hora,
    lloviendo: bot.isRaining,
    suelo: bloque?.name,
    dimension: bot.game.dimension,
    hostiles_cerca: hostiles.length ? hostiles : 'ninguno',
    jugadores_cerca: jugadores.length ? jugadores : 'ninguno',
    inventario: bot.inventory.items().map(i => `${i.name} x${i.count}`),
    equipado: bot.heldItem?.name || 'nada'
  }
}

// nombre -> { schema, run(bot, args, ctx) }
const TOOLS = {
  mirar_alrededor: {
    desc: 'Mira que hay alrededor: posicion, vida, hora, mobs, jugadores e inventario. Usalo cuando necesites saber el estado antes de decidir.',
    params: {},
    run: async (bot) => resumenEntorno(bot)
  },

  ir_donde_jugador: {
    desc: 'Camina hasta donde esta un jugador y se queda ahi.',
    params: { jugador: { type: 'string', description: 'nombre del jugador' } },
    run: async (bot, a) => {
      const e = bot.players[a.jugador]?.entity
      if (!e) return { error: `no veo a ${a.jugador}` }
      await S.irA(bot, e.position.x, e.position.y, e.position.z, 2)
      return { ok: true, llegue_a: a.jugador }
    }
  },

  seguir_jugador: {
    desc: 'Sigue a un jugador continuamente hasta que te digan que pares.',
    params: { jugador: { type: 'string', description: 'nombre del jugador' } },
    run: async (bot, a, ctx) => {
      const e = bot.players[a.jugador]?.entity
      if (!e) return { error: `no veo a ${a.jugador}` }
      ctx.seguir(a.jugador)
      return { ok: true, siguiendo: a.jugador }
    }
  },

  parar: {
    desc: 'Deja de moverse, de seguir y de pelear.',
    params: {},
    run: async (bot, a, ctx) => { ctx.parar(); return { ok: true } }
  },

  ir_a_coordenadas: {
    desc: 'Camina hasta unas coordenadas concretas.',
    params: {
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }
    },
    run: async (bot, a) => {
      await S.irA(bot, a.x, a.y, a.z, 1)
      return { ok: true, llegue: [a.x, a.y, a.z] }
    }
  },

  conseguir_bloque: {
    desc: 'Busca un bloque cerca, va, lo mina y recoge lo que suelte. Ej: oak_log, stone, iron_ore, diamond_ore, dirt.',
    params: {
      bloque: { type: 'string', description: 'nombre tecnico del bloque en ingles' },
      cantidad: { type: 'number', description: 'cuantos quieres' }
    },
    run: async (bot, a) => {
      const total = await S.conseguir(bot, a.bloque, a.cantidad || 1)
      return { ok: true, tengo_ahora: total }
    }
  },

  talar_arboles: {
    desc: 'Busca arboles y consigue madera.',
    params: { cantidad: { type: 'number', description: 'troncos aproximados' } },
    run: async (bot, a) => {
      await S.talar(bot, a.cantidad || 16)
      const logs = bot.inventory.items().filter(i => i.name.endsWith('_log'))
        .reduce((n, i) => n + i.count, 0)
      return { ok: true, troncos: logs }
    }
  },

  craftear: {
    desc: 'Craftea un item. Si hace falta mesa de crafteo la busca, y si no la tiene la fabrica y la coloca.',
    params: {
      item: { type: 'string', description: 'nombre tecnico en ingles, ej: stick, oak_planks, iron_pickaxe' },
      cantidad: { type: 'number' }
    },
    run: async (bot, a) => {
      const total = await S.craftear(bot, a.item, a.cantidad || 1)
      return { ok: true, tengo_ahora: total }
    }
  },

  equiparse: {
    desc: 'Craftea y se pone las mejores herramientas y armadura posibles con lo que tiene.',
    params: {},
    run: async (bot) => ({ ok: true, me_hice: await S.equiparse(bot) })
  },

  atacar: {
    desc: 'Ataca a un mob o jugador por nombre.',
    params: { objetivo: { type: 'string', description: 'nombre del mob (zombie, skeleton) o del jugador' } },
    run: async (bot, a, ctx) => {
      const o = a.objetivo.toLowerCase()
      const e = bot.nearestEntity(x =>
        x.username?.toLowerCase() === o || x.name?.toLowerCase() === o)
      if (!e) return { error: `no veo ningun ${a.objetivo}` }
      await ctx.equiparArma()
      bot.pvp.attack(e)
      return { ok: true, atacando: a.objetivo }
    }
  },

  tirar_item: {
    desc: 'Tira un item del inventario al suelo, mirando al jugador para darselo.',
    params: {
      item: { type: 'string', description: 'nombre del item' },
      cantidad: { type: 'number', description: 'opcional, por defecto todo el stack' }
    },
    run: async (bot, a) => {
      const it = bot.inventory.items().find(i => i.name.includes(a.item))
      if (!it) return { error: `no tengo ${a.item}` }
      if (a.cantidad) await bot.toss(it.type, null, a.cantidad)
      else await bot.tossStack(it)
      return { ok: true, tire: it.name }
    }
  },

  dormir: {
    desc: 'Busca una cama cerca y se duerme (solo funciona de noche).',
    params: {},
    run: async (bot) => { await S.dormir(bot); return { ok: true } }
  },

  guardar_en_cofre: {
    desc: 'Busca un cofre cerca y guarda lo que lleva, menos herramientas y comida.',
    params: {},
    run: async (bot) => ({ ok: true, guarde: await S.guardarEnCofre(bot) })
  }
}

// --- conversion a los dos formatos de tool calling ---

function schemaJSON (t) {
  const props = {}
  for (const [k, v] of Object.entries(t.params)) props[k] = v
  return {
    type: 'object',
    properties: props,
    required: Object.keys(t.params).filter(k => !/opcional/i.test(t.params[k].description || '')),
    additionalProperties: false
  }
}

const paraAnthropic = () => Object.entries(TOOLS).map(([name, t]) => ({
  name, description: t.desc, input_schema: schemaJSON(t)
}))

const paraOllama = () => Object.entries(TOOLS).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.desc, parameters: schemaJSON(t) }
}))

module.exports = { TOOLS, paraAnthropic, paraOllama, resumenEntorno }
