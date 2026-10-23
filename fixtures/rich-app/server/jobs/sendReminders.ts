type Scheduler = { schedule(expression: string, run: () => void): void };

export function startReminders(cron: Scheduler) {
  cron.schedule('0 9 * * *', () => {
    console.log('nudge customers with an open cart');
  });
}
