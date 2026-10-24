declare function sendEmail(to: string, body: string): Promise<void>;

export async function sendInvoice(to: string) {
  await sendEmail(to, 'Your invoice is ready');
}
