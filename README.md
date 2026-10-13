# MC Bot

Bot de Minecraft con Mineflayer. Movimiento, combate, supervivencia y herramientas para un asistente con Ollama o Anthropic.

## Uso

```sh
npm ci
cp .env.example .env
# Configura el servidor y el backend opcional
./run.sh
```

El cliente usa autenticación offline. Necesita un servidor compatible configurado para ese modo. El repositorio contiene el bot y no distribuye el servidor, mundos, registros ni credenciales.
