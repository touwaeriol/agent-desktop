import { engineCommands, type EngineCommand } from '../shared/engine'
import type { AgentEngine } from './agent/engine'

export async function listEngineCommands(engine: AgentEngine): Promise<EngineCommand[]> {
  const native = await engine.nativeCommands?.().catch(() => [])
  return engineCommands(engine.capabilities(), native ?? [])
}

/** Capture an engine per operation; a hot switch must never redirect an in-flight command. */
export async function executeEngineCommand(
  engine: AgentEngine,
  name: string,
  args: string,
  onModelChanged: () => Promise<unknown>,
  availableModels?: () => Promise<Record<string, unknown>[]>
): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const command = (await listEngineCommands(engine)).find((entry) => entry.name === name)
    if (!command) throw new Error('当前引擎不支持命令 ' + name)
    if (engine.busy()) throw new Error('请等当前回合结束')
    switch (command.action) {
      case 'native':
        if (!engine.executeCommand) throw new Error('当前引擎没有原生命令执行入口')
        return { ok: true, ...(await engine.executeCommand(name, args)) }
      case 'model': {
        const models = await (availableModels ? availableModels() : engine.models())
        if (!args) return { ok: true, text: models.map((m) => m.provider + '/' + m.id).join('\n') }
        const matches = models.filter((m) => m.id === args || m.provider + '/' + m.id === args)
        if (!matches.length) throw new Error('当前引擎模型目录中没有 ' + args)
        if (matches.length > 1) throw new Error('模型名称不唯一，请使用 provider/model：' + args)
        const model = matches[0]
        await engine.setModel(String(model.provider), String(model.id))
        await onModelChanged()
        return { ok: true, text: '模型已切换为 ' + String(model.id) }
      }
      case 'thinking':
        if (!args) return { ok: true, text: (await engine.thinkingLevels()).join(' / ') }
        await engine.setThinkingLevel(args)
        return { ok: true, text: '思考等级：' + args }
      case 'status':
        return {
          ok: true,
          text: JSON.stringify({ engine: engine.id, model: engine.state().model, ...(await engine.stats()) }, null, 2)
        }
      default:
        throw new Error('此命令须从对应桌面入口执行')
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
