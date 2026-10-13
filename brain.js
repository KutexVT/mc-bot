// Cerebro del bot: entiende lenguaje normal y decide que herramientas usar.
// Dos backends: Anthropic si hay API key, ollama local si no.
const { TOOLS, paraAnthropic, paraOllama, resumenEntorno } = require('./tools')

const BACKEND = process.env.MC_BRAIN ||
  (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama')
const MODELO_OLLAMA = process.env.OLLAMA_MODEL || 'Qwen3.5'
const MODELO_ANTHROPIC = process.env.ANTHROPIC_MODEL || 'claude-opus-5'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'

const PERSONA = `Eres Tulpa, un bot que juega Minecraft junto a Kutex_VT (Mikel).
Hablas como el: en español, mensajes MUY cortos, directos, con humor seco.
Sin signos de apertura (nada de ¿ ni ¡), las preguntas terminan en ?? .
Risas: jsjsjs. Nunca uses "jaja". Sin emojis. Nunca uses la palabra "pa" por "para".

Como actuas:
- Estas DENTRO del juego. Si te piden algo, usa las herramientas, no lo describas.
- Si no sabes que hay alrededor, llama primero a mirar_alrededor.
- Los nombres de bloques e items van en ingles tecnico (oak_log, iron_ore, stone).
- Si algo falla, dilo tal cual y corto. No inventes que lo hiciste.
- Si te hablan sin pedirte nada, solo contesta, sin usar herramientas.
- El chat de Minecraft corta a 250 caracteres: responde en 1 o 2 frases cortas.`

// ---------- backend: ollama ----------
async function pensarOllama (mensajes, herramientas) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELO_OLLAMA,
      messages: mensajes,
      tools: herramientas,
      stream: false,
      think: false,
      options: { temperature: 0.7, num_ctx: 8192 }
    })
  })
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  const m = j.message || {}
  return {
    texto: limpiar(m.content || ''),
    llamadas: (m.tool_calls || []).map(c => ({
      id: c.id || c.function.name,
      nombre: c.function.name,
      args: typeof c.function.arguments === 'string'
        ? JSON.parse(c.function.arguments) : (c.function.arguments || {})
    })),
    crudo: m
  }
}

// Qwen y compañia a veces sueltan el razonamiento en <think>
const limpiar = t => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

// ---------- backend: anthropic ----------
let clienteAnthropic = null
async function pensarAnthropic (mensajes, herramientas) {
  if (!clienteAnthropic) {
    const Anthropic = require('@anthropic-ai/sdk')
    clienteAnthropic = new (Anthropic.default || Anthropic)()
  }
  const r = await clienteAnthropic.messages.create({
    model: MODELO_ANTHROPIC,
    max_tokens: 2048,
    system: PERSONA,
    output_config: { effort: 'low' },   // es un chat de juego: prioriza latencia
    tools: herramientas,
    messages: mensajes
  })
  return {
    texto: r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim(),
    llamadas: r.content.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, nombre: b.name, args: b.input })),
    crudo: r.content,
    fin: r.stop_reason
  }
}

// ---------- cerebro ----------
function crearCerebro (bot, ctx, log) {
  const historial = []          // se mantiene corto a proposito
  let ocupado = false

  async function ejecutar (llamada) {
    const t = TOOLS[llamada.nombre]
    if (!t) return { error: `no existe la herramienta ${llamada.nombre}` }
    log(`herramienta: ${llamada.nombre}(${JSON.stringify(llamada.args)})`)
    try {
      return await t.run(bot, llamada.args || {}, ctx)
    } catch (e) {
      return { error: e.message }
    }
  }

  async function responder (quien, texto) {
    if (ocupado) return
    ocupado = true
    try {
      const estado = JSON.stringify(resumenEntorno(bot))
      historial.push({ role: 'user', content: `[estado del juego: ${estado}]\n${quien}: ${texto}` })
      while (historial.length > 12) historial.shift()

      let vueltas = 0
      while (vueltas++ < 6) {
        const res = BACKEND === 'anthropic'
          ? await pensarAnthropic(historial, paraAnthropic())
          : await pensarOllama([{ role: 'system', content: PERSONA }, ...historial], paraOllama())

        if (!res.llamadas.length) {
          if (res.texto) { historial.push({ role: 'assistant', content: res.texto }); ctx.decir(res.texto) }
          return
        }

        // ejecutar las herramientas y devolver los resultados
        const resultados = []
        for (const ll of res.llamadas) resultados.push({ ll, out: await ejecutar(ll) })

        if (BACKEND === 'anthropic') {
          historial.push({ role: 'assistant', content: res.crudo })
          historial.push({
            role: 'user',
            content: resultados.map(({ ll, out }) => ({
              type: 'tool_result', tool_use_id: ll.id, content: JSON.stringify(out)
            }))
          })
        } else {
          historial.push(res.crudo)
          for (const { ll, out } of resultados) {
            historial.push({ role: 'tool', name: ll.nombre, content: JSON.stringify(out) })
          }
        }
        if (res.texto) ctx.decir(res.texto)
      }
      ctx.decir('Me enrede, dime otra vez')
    } catch (e) {
      log('cerebro fallo:', e.message)
      ctx.decir('Se me trabo el cerebro')
    } finally {
      ocupado = false
    }
  }

  return { responder, backend: BACKEND, modelo: BACKEND === 'anthropic' ? MODELO_ANTHROPIC : MODELO_OLLAMA }
}

module.exports = { crearCerebro }
