import { describe, expect, test } from 'bun:test'
import {
  parseTaskNotificationXml,
  shouldForwardTaskNotificationToModel,
} from './taskNotificationPolicy.js'

describe('task notification policy', () => {
  test('does not re-enter the model for local agent terminal notifications in structured output', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>agent-1</task-id>
<task-type>local_agent</task-type>
<output-file>/tmp/agent-1.out</output-file>
<status>completed</status>
<summary>Agent "Probe" completed</summary>
</task-notification>`)

    expect(shouldForwardTaskNotificationToModel(notification, { structuredOutput: true })).toBe(false)
  })

  test('keeps local agent notifications as model input for plain print mode', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>agent-1</task-id>
<task-type>local_agent</task-type>
<output-file>/tmp/agent-1.out</output-file>
<status>completed</status>
<summary>Agent "Probe" completed</summary>
</task-notification>`)

    expect(shouldForwardTaskNotificationToModel(notification, { structuredOutput: false })).toBe(true)
  })

  test('continues forwarding background shell notifications to the model', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>bash-1</task-id>
<output-file>/tmp/bash-1.out</output-file>
<status>completed</status>
<summary>Background command "bun test" completed</summary>
</task-notification>`)

    expect(shouldForwardTaskNotificationToModel(notification, { structuredOutput: true })).toBe(true)
  })
})
