import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';

import { REPO_ROOT } from './paths';

export type ClaudeRunResult = {
    output: string;
    status: number | null;
};

type RunClaudeOptions = {
    args: string[];
    input: string;
    timeoutMs?: number;
};

const ClaudeResultSchema = z.object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
});

export function processAgentOutput(rawOutput: string): z.infer<typeof ClaudeResultSchema> {
    for (const line of rawOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const parsed = ClaudeResultSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success && parsed.data.type === 'result') {
            return parsed.data;
        }
    }

    throw new Error('no result entry in claude stdout');
}

export async function runClaude({
    args,
    input,
    timeoutMs,
}: RunClaudeOptions): Promise<ClaudeRunResult> {
    const env = { ...process.env };
    // Prevents an internal Claude Code setting from accidentally being inherited.
    delete env.MCP_CONNECTION_NONBLOCKING;

    const child = spawn(`${REPO_ROOT}/node_modules/.bin/claude`, args, {
        cwd: REPO_ROOT,
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
    });

    child.stdin.end(input);
    // `{ end: false }` so closing Claude's stdout does not close this process's stderr.
    child.stdout.pipe(process.stderr, { end: false });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf-8');
    });

    const timeout =
        timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    try {
        const [status] = await Promise.race([
            once(child, 'close'),
            once(child, 'error').then(([e]) => {
                throw e;
            }),
        ]);

        if (timeoutMs !== undefined && child.killed) {
            throw new Error('timed out');
        }

        return { output, status };
    } finally {
        clearTimeout(timeout);
    }
}
