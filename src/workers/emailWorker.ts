// ===========================================
// EMAIL WORKER
// ===========================================
// Background job for sending emails
// Handles notifications, password resets, and marketing emails

import nodemailer, { Transporter } from 'nodemailer';
import { NotificationType } from '@prisma/client';
import prisma from '../../prisma/client';
import { config } from '../config';
import { logInfo, logError, logDebug } from '../utils/logger';

// Email configuration — using environment variables from .env
const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const fromEmail = process.env.FROM_EMAIL || 'noreply@yourplatform.com';
const emailEnabled = process.env.EMAIL_ENABLED !== 'false';

// Configure SMTP transporter (nodemailer)
const transporter: Transporter | null =
  smtpHost && smtpUser && smtpPass
    ? nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
      })
    : null;

interface EmailJob {
  to: string;
  subject: string;
  template: EmailTemplate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  userId?: string;
}

enum EmailTemplate {
  WELCOME = 'welcome',
  PASSWORD_RESET = 'password_reset',
  VERIFICATION = 'verification',
  NOTIFICATION = 'notification',
  PAYOUT_COMPLETED = 'payout_completed',
  DEAL_ACCEPTED = 'deal_accepted',
  CONTENT_PROCESSED = 'content_processed'
}

export class EmailWorker {
  /**
   * Send email in background
   */
  static async sendEmail(job: EmailJob): Promise<void> {
    if (!emailEnabled || !transporter) {
      logInfo(
        `[EmailWorker] Email sending disabled or not configured. Would send to ${job.to}: ${job.subject}. ` +
          `emailEnabled=${emailEnabled}, hasTransporter=${!!transporter}`
      );
      return;
    }

    try {
      logInfo(`[EmailWorker] Sending email to ${job.to}`);

      const info = await transporter.sendMail({
        from: `"Creator Platform" <${fromEmail}>`,
        to: job.to,
        subject: job.subject,
        html: this.generateEmailTemplate(job.template, job.data),
        headers: { 'X-Template': job.template },
      });
      const messageId = info.messageId || 'unknown';
      logDebug('[EmailWorker] SMTP response summary', {
        to: job.to,
        subject: job.subject,
        template: job.template,
        messageId,
        response: info.response,
      });

      // Track email sent
      if (job.userId) {
        await prisma.analyticsEvent.create({
          data: {
            userId: job.userId,
            eventType: 'email',
            eventName: `sent_${job.template}`,
            properties: {
              to: job.to,
              subject: job.subject,
              messageId: messageId
            }
          }
        });
      }

      logInfo(`[EmailWorker] Email sent successfully to ${job.to} with ID: ${messageId}`);

    } catch (error) {
      logError(error instanceof Error ? error : new Error(String(error)), { context: `[EmailWorker] Error sending email to ${job.to}` });
      throw error;
    }
  }

  /**
   * Send notification email
   */
  static async sendNotificationEmail(
    userId: string,
    type: NotificationType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true }
    });

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const notificationSettings = await prisma.notificationSettings.findUnique({
      where: { userId }
    });

    // Check if email notifications are enabled
    if (!notificationSettings?.emailEnabled) {
      logDebug(`[EmailWorker] Email notifications disabled for user ${userId}`);
      return;
    }

    let template: EmailTemplate;
    let subject: string;

    switch (type) {
      case NotificationType.CHAT_MESSAGE:
        if (!notificationSettings.emailChat) return;
        template = EmailTemplate.NOTIFICATION;
        subject = 'New Message from Creator';
        break;
        
      case NotificationType.DEAL_ACCEPTED:
        if (!notificationSettings.emailDeals) return;
        template = EmailTemplate.DEAL_ACCEPTED;
        subject = 'Your Deal Application was Accepted!';
        break;
        
      case NotificationType.PAYOUT_COMPLETED:
        if (!notificationSettings.emailPayments) return;
        template = EmailTemplate.PAYOUT_COMPLETED;
        subject = 'Payout Completed Successfully';
        break;
        
      case NotificationType.CONTENT_PROCESSED:
        template = EmailTemplate.CONTENT_PROCESSED;
        subject = 'Your Content Has Been Processed';
        break;
        
      default:
        if (!notificationSettings.emailDeals) return;
        template = EmailTemplate.NOTIFICATION;
        subject = 'New Notification';
    }

    await this.sendEmail({
      to: user.email,
      subject,
      template,
      data: { ...data, userName: user.name },
      userId
    });
  }

  /**
   * Send welcome email
   */
  static async sendWelcomeEmail(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true }
    });

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    await this.sendEmail({
      to: user.email,
      subject: 'Welcome to Creator Platform!',
      template: EmailTemplate.WELCOME,
      data: { userName: user.name },
      userId
    });
  }

  /**
   * Send password reset email
   */
  static async sendPasswordResetEmail(
    email: string,
    token: string,
    name: string
  ): Promise<void> {
    const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
    
    await this.sendEmail({
      to: email,
      subject: 'Password Reset Request',
      template: EmailTemplate.PASSWORD_RESET,
      data: { 
        userName: name,
        resetUrl,
        expiresIn: '1 hour'
      }
    });
  }

  /**
   * Send email verification
   */
  static async sendVerificationEmail(
    email: string,
    token: string,
    name: string,
    redirect?: string
  ): Promise<void> {
    const redirectSuffix = redirect ? `&redirect=${encodeURIComponent(redirect)}` : '';
    const verifyUrl = `${config.frontendUrl}/verify-email?token=${token}${redirectSuffix}`;
    
    await this.sendEmail({
      to: email,
      subject: 'Verify Your Email Address',
      template: EmailTemplate.VERIFICATION,
      data: { 
        userName: name,
        verifyUrl
      }
    });
  }

  /**
   * Generate email template HTML
   */
  private static generateEmailTemplate(
    template: EmailTemplate,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>
  ): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const templates: Record<EmailTemplate, (data: any) => string> = {
      [EmailTemplate.WELCOME]: (d) => `
        <h1>Welcome to Creator Platform, ${d.userName}!</h1>
        <p>Thank you for joining our platform. You can now start connecting with creators and building your presence.</p>
        <p><a href="${config.frontendUrl}">Get Started</a></p>
      `,
      
      [EmailTemplate.PASSWORD_RESET]: (d) => `
        <h1>Password Reset Request</h1>
        <p>Hello ${d.userName},</p>
        <p>You requested to reset your password. Click the link below to set a new password:</p>
        <p><a href="${d.resetUrl}">Reset Password</a></p>
        <p>This link will expire in ${d.expiresIn}.</p>
      `,
      
      [EmailTemplate.VERIFICATION]: (d) => `
        <h1>Verify Your Email</h1>
        <p>Hello ${d.userName},</p>
        <p>Please verify your email address by clicking the link below:</p>
        <p><a href="${d.verifyUrl}">Verify Email</a></p>
      `,
      
      [EmailTemplate.NOTIFICATION]: (d) => `
        <h1>New Notification</h1>
        <p>Hello ${d.userName},</p>
        <p>${d.message || 'You have a new notification.'}</p>
        ${d.actionUrl ? `<p><a href="${d.actionUrl}">View Details</a></p>` : ''}
      `,
      
      [EmailTemplate.PAYOUT_COMPLETED]: (d) => `
        <h1>Payout Completed</h1>
        <p>Hello ${d.userName},</p>
        <p>Your payout of ₹${d.amount} has been processed successfully.</p>
        <p>UTR: ${d.utr}</p>
        <p>Thank you for using our platform!</p>
      `,
      
      [EmailTemplate.DEAL_ACCEPTED]: (d) => `
        <h1>Deal Accepted!</h1>
        <p>Hello ${d.userName},</p>
        <p>Great news! Your application for "${d.opportunityTitle}" has been accepted.</p>
        <p>Amount: ₹${d.amount}</p>
        <p><a href="${config.frontendUrl}/deals">View Deal Details</a></p>
      `,
      
      [EmailTemplate.CONTENT_PROCESSED]: (d) => `
        <h1>Content Processed</h1>
        <p>Hello ${d.userName},</p>
        <p>Your content "${d.title}" has been successfully processed and is now live.</p>
        <p><a href="${d.contentUrl || config.frontendUrl}">View Content</a></p>
      `
    };

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Creator Platform</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          ${templates[template](data)}
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #666;">
            This email was sent from Creator Platform. 
            If you didn't request this, please ignore this email.
          </p>
          <p style="font-size: 12px; color: #666;">
            &copy; ${new Date().getFullYear()} Creator Platform. All rights reserved.
          </p>
        </div>
      </body>
      </html>
    `;
  }
}
