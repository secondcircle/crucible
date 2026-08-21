// @vitest-environment node
//
// Jira's configuration is two files, and everything below is a function of
// their text: no disk, no environment, no network.
import { describe, expect, it } from 'vitest'
import {
  chooseIssueHost,
  hasJiraCredentialKey,
  parseEnvFile,
  parseJiraBaseUrl,
  parseJiraPointer,
  readJiraSetup
} from './jira-config'

const ENV = [
  '# the work repositories share these',
  'JIRA_EMAIL=ike@example.com',
  'JIRA_API_TOKEN=ATATT-secret',
  'JIRA_BASE_URL=https://secondcircle.atlassian.net',
  'JIRA_PROJECT_KEY=EK'
].join('\n')

const POINTER = '{ "projectKey": "EK" }'

describe('reading .env.local', () => {
  it('takes KEY=VALUE lines and ignores blanks and comments', () => {
    expect(parseEnvFile(ENV)).toEqual({
      JIRA_EMAIL: 'ike@example.com',
      JIRA_API_TOKEN: 'ATATT-secret',
      JIRA_BASE_URL: 'https://secondcircle.atlassian.net',
      JIRA_PROJECT_KEY: 'EK'
    })
    expect(parseEnvFile('\n\n   \n# only a comment\n')).toEqual({})
  })

  it('keeps everything after the first = , which is how a token survives', () => {
    // A base64 token can end in `=`, and a URL carries one in its query.
    expect(parseEnvFile('JIRA_API_TOKEN=abc==')['JIRA_API_TOKEN']).toBe('abc==')
    expect(parseEnvFile('A=b=c=d')['A']).toBe('b=c=d')
  })

  it('trims the key and the value, and drops a line that names nothing', () => {
    expect(parseEnvFile('  JIRA_EMAIL  =  ike@example.com  ')['JIRA_EMAIL']).toBe(
      'ike@example.com'
    )
    expect(parseEnvFile('no equals sign here')).toEqual({})
    expect(parseEnvFile('=orphan')).toEqual({})
  })

  it('lets a later line win, which is what appending an override looks like', () => {
    expect(parseEnvFile('A=first\nA=second')['A']).toBe('second')
  })

  it('reads a windows-authored file, whose lines end in a carriage return', () => {
    expect(parseEnvFile('JIRA_EMAIL=ike@example.com\r\nJIRA_API_TOKEN=t\r\n')).toEqual({
      JIRA_EMAIL: 'ike@example.com',
      JIRA_API_TOKEN: 't'
    })
  })

  it('says whether any Jira key is named at all, however incomplete', () => {
    expect(hasJiraCredentialKey(undefined)).toBe(false)
    expect(hasJiraCredentialKey('SONAR_TOKEN=x')).toBe(false)
    expect(hasJiraCredentialKey('JIRA_EMAIL=ike@example.com')).toBe(true)
    // Named but empty still counts as intent: the board then says it is empty.
    expect(hasJiraCredentialKey('JIRA_API_TOKEN=')).toBe(true)
  })
})

describe('reading the base URL', () => {
  it('takes a site URL and drops the trailing slash the request supplies', () => {
    expect(parseJiraBaseUrl('https://secondcircle.atlassian.net')).toBe(
      'https://secondcircle.atlassian.net'
    )
    expect(parseJiraBaseUrl('https://secondcircle.atlassian.net///')).toBe(
      'https://secondcircle.atlassian.net'
    )
    // A path prefix survives: not every Jira lives at the root of its host.
    expect(parseJiraBaseUrl('  http://jira.internal:8080/jira/  ')).toBe(
      'http://jira.internal:8080/jira'
    )
  })

  it('takes nothing that cannot address a request', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      // The scheme dropped, which is what copying a hostname out of a browser
      // gives you, and the value that used to throw at the first request.
      'secondcircle.atlassian.net',
      'https://',
      'mailto:ike@example.com',
      'your Jira site'
    ]) {
      expect(parseJiraBaseUrl(value)).toBeUndefined()
    }
  })
})

describe('reading the pointer file', () => {
  it('takes the project key and ignores fields it does not know', () => {
    expect(parseJiraPointer(POINTER)).toBe('EK')
    expect(parseJiraPointer('{"projectKey":"EK","boardId":42}')).toBe('EK')
    expect(parseJiraPointer('{ "projectKey": "  EK  " }')).toBe('EK')
  })

  it('names no project where there is none to name', () => {
    for (const text of [
      undefined,
      '',
      'not json at all',
      '[]',
      'null',
      '{}',
      '{"projectKey":""}',
      '{"projectKey":"   "}',
      '{"projectKey":42}'
    ]) {
      expect(parseJiraPointer(text)).toBeUndefined()
    }
  })
})

describe('the two files together', () => {
  it('is ready when both are there, with the base URL stripped of its slash', () => {
    const setup = readJiraSetup({
      pointer: POINTER,
      env: `${ENV}\nJIRA_BASE_URL=https://secondcircle.atlassian.net/`
    })

    expect(setup).toEqual({
      kind: 'ready',
      config: {
        baseUrl: 'https://secondcircle.atlassian.net',
        email: 'ike@example.com',
        token: 'ATATT-secret',
        projectKey: 'EK'
      }
    })
  })

  it('never reads JIRA_PROJECT_KEY: the pointer has exactly one source', () => {
    const setup = readJiraSetup({ env: ENV })

    expect(setup.kind).toBe('incomplete')
    // The env file names EK, and it is still the pointer file that is missing.
    expect(setup.kind === 'incomplete' && setup.missing.map((piece) => piece.name)).toEqual([
      '.crucible/jira.json'
    ])
  })

  it('lists every missing piece at once, each with where it goes', () => {
    const setup = readJiraSetup({ env: 'JIRA_EMAIL=ike@example.com' })
    if (setup.kind !== 'incomplete') throw new Error('expected an incomplete setup')

    expect(setup.missing.map((piece) => piece.name)).toEqual([
      'JIRA_BASE_URL',
      'JIRA_API_TOKEN',
      '.crucible/jira.json'
    ])
    for (const piece of setup.missing) expect(piece.where.length).toBeGreaterThan(20)
    // Each sentence names the file the piece belongs in.
    expect(setup.missing[0]?.where).toContain('.env.local')
    expect(setup.missing[2]?.where).toContain('projectKey')
  })

  it('counts a base URL that cannot address a request as missing', () => {
    // Never ready with it: a request built on this throws, and the board says
    // which key to fix instead of going quiet.
    const setup = readJiraSetup({
      pointer: POINTER,
      env: `${ENV}\nJIRA_BASE_URL=secondcircle.atlassian.net`
    })

    expect(setup.kind === 'incomplete' && setup.missing.map((piece) => piece.name)).toEqual([
      'JIRA_BASE_URL'
    ])
    // And the sentence beside it shows the shape, scheme included.
    expect(setup.kind === 'incomplete' && setup.missing[0]?.where).toContain('https://')
  })

  it('counts a key present but empty as missing', () => {
    const setup = readJiraSetup({ pointer: POINTER, env: `${ENV}\nJIRA_API_TOKEN=` })

    expect(setup.kind === 'incomplete' && setup.missing.map((piece) => piece.name)).toEqual([
      'JIRA_API_TOKEN'
    ])
  })

  it('counts a pointer that names no project as missing, unreadable or not', () => {
    for (const pointer of ['{}', 'garbage{']) {
      const setup = readJiraSetup({ pointer, env: ENV })
      expect(setup.kind === 'incomplete' && setup.missing.map((piece) => piece.name)).toEqual([
        '.crucible/jira.json'
      ])
    }
  })

  it('is incomplete with nothing at all, naming all four pieces', () => {
    const setup = readJiraSetup({})

    expect(setup.kind === 'incomplete' && setup.missing).toHaveLength(4)
  })
})

describe('which host a workspace reads its issues from', () => {
  const facts = (over: Partial<Parameters<typeof chooseIssueHost>[0]> = {}) => ({
    repository: true,
    jiraPointer: false,
    githubRemote: false,
    jiraCredential: false,
    ...over
  })

  it('is nobody at all outside a git repository', () => {
    expect(chooseIssueHost(facts({ repository: false, jiraPointer: true }))).toBe('none')
  })

  it('is Jira where the pointer file is, even over a GitHub remote', () => {
    expect(chooseIssueHost(facts({ jiraPointer: true, githubRemote: true }))).toBe('jira')
  })

  it('is GitHub for a GitHub remote with no pointer file', () => {
    expect(chooseIssueHost(facts({ githubRemote: true, jiraCredential: true }))).toBe('github')
  })

  it('is Jira where the keys are there but the pointer is not', () => {
    expect(chooseIssueHost(facts({ jiraCredential: true }))).toBe('jira')
  })

  it('is nobody where nothing points anywhere', () => {
    expect(chooseIssueHost(facts())).toBe('none')
  })
})
