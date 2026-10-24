export function welcomeEmail(name: string) {
  return { subject: `Welcome, ${name}`, body: 'Thanks for joining.' };
}
