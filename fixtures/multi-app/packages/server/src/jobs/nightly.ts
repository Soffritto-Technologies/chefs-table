type Scheduler = { schedule(expression: string, run: () => void): void };

export function startNightly(cron: Scheduler) {
  cron.schedule('0 2 * * *', () => console.log('clean up old sessions'));
}
