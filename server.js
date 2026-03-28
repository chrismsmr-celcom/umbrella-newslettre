const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// ==================== MIDDLEWARE ====================
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const emailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: { error: 'Trop d\'emails envoyés. Réessayez dans une heure.' },
    keyGenerator: (req) => req.body?.user_id || req.ip
});

// ==================== SUPABASE ====================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ==================== RESEND ====================
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = process.env.FROM_NAME || 'Umbrella Newsletter';

// ==================== FONCTIONS ====================
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function authenticateUser(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
}

async function sendEmail(to, subject, html) {
    try {
        const { data, error } = await resend.emails.send({
            from: `${FROM_NAME} <${FROM_EMAIL}>`,
            to: [to],
            subject: subject,
            html: html
        });
        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Erreur Resend:', error);
        throw error;
    }
}

// ==================== ROUTES ====================

// Health check (important pour Render)
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Inscription avec double opt-in
app.post('/api/subscribe', async (req, res) => {
    const { email, name, source } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email requis' });
    }
    
    try {
        const { data: existing } = await supabase
            .from('subscribers')
            .select('id, status')
            .eq('email', email)
            .single();
        
        if (existing && existing.status === 'active') {
            return res.status(400).json({ error: 'Cet email est déjà abonné' });
        }
        
        const token = generateToken();
        
        const { error } = await supabase
            .from('subscribers')
            .insert({
                email,
                name,
                status: 'pending',
                confirmation_token: token,
                ip_address: req.ip,
                user_agent: req.headers['user-agent'],
                source
            });
        
        if (error) throw error;
        
        await sendConfirmationEmail(email, name, token);
        
        res.json({ 
            success: true, 
            message: 'Email de confirmation envoyé'
        });
        
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur lors de l\'inscription' });
    }
});

// Confirmation
app.get('/api/confirm/:token', async (req, res) => {
    const { token } = req.params;
    
    try {
        const { data: subscriber, error } = await supabase
            .from('subscribers')
            .update({ 
                status: 'active', 
                confirmed_at: new Date().toISOString(),
                confirmation_token: null
            })
            .eq('confirmation_token', token)
            .select()
            .single();
        
        if (error || !subscriber) {
            return res.status(400).send('Token invalide');
        }
        
        const unsubscribeToken = generateToken();
        await supabase
            .from('unsubscribe_links')
            .insert({
                subscriber_id: subscriber.id,
                token: unsubscribeToken
            });
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Confirmation</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                <h1>✅ Confirmation réussie !</h1>
                <p>Votre email ${subscriber.email} est maintenant inscrit.</p>
                <a href="${process.env.FRONTEND_URL}" style="color: #f5c400;">Retour au site</a>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).send('Erreur lors de la confirmation');
    }
});

// Désabonnement
app.get('/api/unsubscribe/:token', async (req, res) => {
    const { token } = req.params;
    
    try {
        const { data: link } = await supabase
            .from('unsubscribe_links')
            .select('subscriber_id')
            .eq('token', token)
            .single();
        
        if (!link) {
            return res.status(400).send('Lien invalide');
        }
        
        await supabase
            .from('subscribers')
            .update({ 
                status: 'unsubscribed', 
                unsubscribed_at: new Date().toISOString()
            })
            .eq('id', link.subscriber_id);
        
        await supabase
            .from('unsubscribe_links')
            .delete()
            .eq('token', token);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Désabonnement</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                <h1>✅ Désabonnement confirmé</h1>
                <p>Vous ne recevrez plus nos newsletters.</p>
                <a href="${process.env.FRONTEND_URL}" style="color: #f5c400;">Retour au site</a>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).send('Erreur');
    }
});

// Envoi newsletter (authentifié)
app.post('/api/newsletter/send', emailLimiter, async (req, res) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    
    const { subject, html_content, test_email } = req.body;
    
    if (!subject || !html_content) {
        return res.status(400).json({ error: 'Sujet et contenu requis' });
    }
    
    try {
        if (test_email) {
            await sendEmail(test_email, subject, html_content);
            return res.json({ success: true, message: 'Test envoyé' });
        }
        
        const { data: subscribers } = await supabase
            .from('subscribers')
            .select('id, email')
            .eq('status', 'active');
        
        let sentCount = 0;
        
        for (const sub of subscribers) {
            try {
                const { data: link } = await supabase
                    .from('unsubscribe_links')
                    .select('token')
                    .eq('subscriber_id', sub.id)
                    .single();
                
                const token = link?.token || generateToken();
                const unsubscribeUrl = `${process.env.BACKEND_URL}/api/unsubscribe/${token}`;
                const personalizedHtml = html_content.replace(/{{unsubscribe_url}}/g, unsubscribeUrl);
                
                await sendEmail(sub.email, subject, personalizedHtml);
                sentCount++;
                
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (e) {
                console.error(`Erreur envoi à ${sub.email}:`, e);
            }
        }
        
        res.json({ success: true, sent: sentCount, total: subscribers.length });
        
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur lors de l\'envoi' });
    }
});

async function sendConfirmationEmail(email, name, token) {
    const confirmUrl = `${process.env.BACKEND_URL}/api/confirm/${token}`;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>Confirmation</title></head>
        <body style="font-family: Arial, sans-serif; padding: 40px;">
            <div style="max-width: 500px; margin: 0 auto;">
                <h1>Confirmez votre inscription</h1>
                <p>Bonjour${name ? ` ${name}` : ''},</p>
                <a href="${confirmUrl}" style="background: #f5c400; color: #0f172a; padding: 12px 24px; text-decoration: none; border-radius: 40px; display: inline-block;">Confirmer</a>
            </div>
        </body>
        </html>
    `;
    
    await sendEmail(email, 'Confirmez votre inscription', html);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
