export const websocketExamples = {
    title: 'Socket.IO gateways, events, rooms, and browser connection',
    useWhen: 'Use when creating realtime features.',
    examples: [
      {
        name: 'Browser client connection through app bridge',
        code: `import { io } from "socket.io-client"

const socket = io("/chat", {
  path: "/socket.io",
  withCredentials: true,
  transports: ["polling", "websocket"]
})`,
        notes: [
          '/chat is the Socket.IO namespace.',
          '/socket.io is the app-origin transport path proxied to Enfyra app /ws/socket.io.',
          'Do not connect browser code directly to the hidden backend.',
        ],
      },
      {
        name: 'Connection script confirms authenticated readiness',
        code: `if (!@USER?.id) {
  @SOCKET.disconnect()
  return
}

@SOCKET.reply("chat:ready", { userId: @USER.id })`,
        notes: [
          'Authenticated Enfyra sockets already load @USER.',
          'Enfyra joins user_<userId> automatically after the connection script succeeds; do not manually duplicate that lifecycle room.',
        ],
      },
      {
        name: 'Chat join event',
        code: `const conversationId = @BODY.conversationId
if (!conversationId) @THROW400("conversationId is required")

const membership = await #secure.chat_conversation_member.find({
  filter: {
    conversation: { id: { _eq: conversationId } },
    member: { id: { _eq: @USER.id } }
  },
  limit: 1
})

if (!membership.data[0]) @THROW403("Not a conversation member")

@SOCKET.join(\`conversation:\${conversationId}\`)
@SOCKET.reply("chat:joined", { conversationId })`,
        notes: [
          'Join conversation rooms, not member-id rooms.',
          'conversationId is a request/room identifier; DB filters still use the relation property conversation.',
          'Check membership server-side; do not trust the client.',
          'Use #secure.table_name for explicit user-facing table access so field permissions remain enforced; still select exact fields and sanitize returned data.',
        ],
      },
      {
        name: 'Chat message event with room broadcast and persistence',
        code: `const { conversationId, text, clientId } = @BODY
if (!conversationId || !text) @THROW400("conversationId and text are required")

const membership = await #secure.chat_conversation_member.find({
  filter: {
    conversation: { id: { _eq: conversationId } },
    member: { id: { _eq: @USER.id } }
  },
  limit: 1
})
if (!membership.data[0]) @THROW403("Not a conversation member")

const created = await #secure.chat_message.create({
  data: {
    conversation: { id: conversationId },
    sender: { id: @USER.id },
    text,
    persistStatus: "persisted"
  }
})

const message = created.data?.[0] ?? null
if (message?.id) {
  await #secure.chat_conversation.update({
    id: conversationId,
    data: { lastMessage: { id: message.id }, updatedAt: message.createdAt || new Date().toISOString() }
  })
}
@SOCKET.emitToCurrentRoom(\`conversation:\${conversationId}\`, "chat:message", {
  clientId,
  message
})

return { ok: true, message }`,
        notes: [
          'Do not ask the client for senderId. The sender relation is derived from @USER.id.',
          'conversationId is accepted only as the room/business identifier; persistence uses relation properties conversation and sender, not physical FK fields.',
          'Event scripts should explicitly emit replies/broadcasts.',
          '@SOCKET has no generic emit() method. Use reply/emitToCurrentRoom/broadcastToRoom in bound websocket scripts.',
          'Use #table_name for explicit table access in generated scripts; select exact fields, enforce membership checks, and return shaped payloads.',
        ],
      },
    ],
  };
