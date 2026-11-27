const { command } = require('../../lib/command')
const { spawnCommand, printError, runMain } = require('../../lib/executionUtils')
const { modifyFile } = require('../../lib/filesUtils')
const { addNewChangesToChangelog } = require('./lib/addNewChangesToChangelog')
const { CHANGELOG_FILE } = require('./lib/constants')

function resolveEditor() {
  try {
    const gitEditor = command`git var GIT_EDITOR`.run().trim()
    if (gitEditor) {
      return gitEditor
    }
  } catch {
    // Fall back to standard shell variables when git cannot resolve an editor.
  }
  return (process.env.VISUAL || process.env.EDITOR || '').trim() || undefined
}

runMain(async () => {
  const editor = resolveEditor()
  if (!editor) {
    printError('No editor configured. Set VISUAL or EDITOR, or run `git config --global core.editor "<editor>"`.')
    process.exit(1)
  }

  await modifyFile(CHANGELOG_FILE, addNewChangesToChangelog)

  const exitCode = await spawnCommand(editor, [CHANGELOG_FILE])
  if (exitCode !== 0) {
    throw new Error(`Editor "${editor}" exited with code ${exitCode}; aborting release`)
  }

  command`yarn run prettier --write ${CHANGELOG_FILE}`.run()

  command`git add ${CHANGELOG_FILE}`.run()
})
