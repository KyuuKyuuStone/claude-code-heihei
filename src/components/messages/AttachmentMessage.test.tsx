import { render } from '../..//ink.js'
import { AttachmentMessage } from './AttachmentMessage'
import type { Attachment } from 'src/utils/attachments.js'

function createOutput() {
  let output = ''
  const stdout = {
    columns: 100,
    rows: 40,
    isTTY: true,
    write(chunk: string | Uint8Array) {
      output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return true
    },
    on() { return this },
    off() { return this },
    once() { return this },
    removeListener() { return this },
  } as unknown as NodeJS.WriteStream
  return { stdout, read: () => output }
}

describe('AttachmentMessage collab_context rendered output', () => {
  it('renders only summary by default and full card in verbose/transcript mode', async () => {
    const attachment = { type: 'collab_context', openTaskCount: 2, text: 'FULL_COLLAB_CARD_CONTENT' } as Attachment
    const output = createOutput()
    const instance = await render(<AttachmentMessage attachment={attachment} addMargin={false} verbose={false} />, {
      stdout: output.stdout,
      stderr: output.stdout,
      stdin: process.stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(output.read()).toContain('已续接协作上下文')
    expect(output.read()).not.toContain('FULL_COLLAB_CARD_CONTENT')
    instance.unmount()

    const verboseOutput = createOutput()
    const verboseInstance = await render(<AttachmentMessage attachment={attachment} addMargin={false} verbose={true} />, {
      stdout: verboseOutput.stdout,
      stderr: verboseOutput.stdout,
      stdin: process.stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(verboseOutput.read()).toContain('FULL_COLLAB_CARD_CONTENT')
    verboseInstance.unmount()
  })
})
