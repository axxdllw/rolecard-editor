/**
 * 侧栏 AI 助手对话记录：按角色卡保存在本地库里，随卡删除，也包含在整库备份中。
 */
import { db, type AssistantChatMessage, type AssistantChatRecord } from '@/db/db'

export function getAssistantChat(cardId: string): Promise<AssistantChatRecord | undefined> {
  return db.assistantChats.get(cardId)
}

export async function saveAssistantChat(cardId: string, messages: AssistantChatMessage[]): Promise<void> {
  await db.assistantChats.put({
    cardId,
    messages,
    updatedAt: Date.now(),
  })
}

export async function clearAssistantChat(cardId: string): Promise<void> {
  await db.assistantChats.delete(cardId)
}

export async function deleteAssistantChats(cardIds: string[]): Promise<void> {
  await db.assistantChats.bulkDelete(cardIds)
}
