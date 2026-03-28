const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// ==================== CONFIGURATION CORS COMPLÈTE ====================
// Liste des origines autorisées
const allowedOrigins = [
    'https://chrismsmr-celcom.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://chrismsmr-celcom.github.io'
];

// Configuration CORS détaillée
const corsOptions = {
    origin: function (origin, callback) {
        // Permettre les requêtes sans origin (Postman, apps mobile)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('❌ Origin bloqué:', origin);
            // En développement, on accepte tous pour tester
            callback(null, true);
            // En production, utilisez:
            // callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'X-Knowledge-Content-Length']
};

// Appliquer CORS avant toutes les routes
app.use(cors(corsOptions));

// Gérer explicitement les requêtes OPTIONS (preflight)
app.options('*', cors(corsOptions));

// ==================== AUTRES MIDDLEWARE ====================
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "unsafe-none" }
}));

app.use(express.json({ limit: '10mb' }));

// Logger pour debug
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url} - Origin: ${req.headers.origin}`);
    next();
});

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

// Route racine (pour vérifier que le serveur fonctionne)
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Umbrella Newsletter API is running',
        endpoints: [
            'GET /api/health',
            'POST /api/subscribe',
            'GET /api/confirm/:token',
            'GET /api/unsubscribe/:token',
            'GET /api/subscribers/count',
            'POST /api/newsletter/send'
        ]
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Inscription avec double opt-in
app.post('/api/subscribe', async (req, res) => {
    console.log('📧 Requête d\'inscription reçue:', req.body);
    
    const { email, name, source } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email requis' });
    }
    
    try {
        // Vérifier si l'email existe déjà
        const { data: existing } = await supabase
            .from('subscribers')
            .select('id, status')
            .eq('email', email)
            .single();
        
        if (existing && existing.status === 'active') {
            return res.status(400).json({ error: 'Cet email est déjà abonné' });
        }
        
        const token = generateToken();
        
        // Ajouter l'abonné
        const { error } = await supabase
            .from('subscribers')
            .insert({
                email,
                name: name || null,
                status: 'pending',
                confirmation_token: token,
                ip_address: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                user_agent: req.headers['user-agent'],
                source: source || 'api'
            });
        
        if (error) throw error;
        
        // Envoyer l'email de confirmation
        await sendConfirmationEmail(email, name, token);
        
        console.log(`✅ Email de confirmation envoyé à ${email}`);
        
        res.json({ 
            success: true, 
            message: 'Email de confirmation envoyé'
        });
        
    } catch (error) {
        console.error('Erreur inscription:', error);
        res.status(500).json({ error: 'Erreur lors de l\'inscription' });
    }
});

// Confirmation
app.get('/api/confirm/:token', async (req, res) => {
    const { token } = req.params;
    console.log(`🔐 Confirmation du token: ${token}`);
    
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
            console.log('❌ Token invalide:', token);
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>Erreur</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1 style="color: #ef4444;">❌ Lien invalide</h1>
                    <p>Ce lien de confirmation est invalide ou a expiré.</p>
                    <a href="${process.env.FRONTEND_URL}/subscribe.html" style="color: #f5c400;">S'inscrire à nouveau</a>
                </body>
                </html>
            `);
        }
        
        // Créer un token de désabonnement
        const unsubscribeToken = generateToken();
        await supabase
            .from('unsubscribe_links')
            .insert({
                subscriber_id: subscriber.id,
                token: unsubscribeToken,
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
        
        console.log(`✅ Email confirmé: ${subscriber.email}`);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Confirmation</title></head>
            <body style="font-family: 'Plus Jakarta Sans', sans-serif; text-align: center; padding: 50px; background: #f8fafc;">
                <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1);">
                    <div style="font-size: 4rem;">✅</div>
                    <h1 style="color: #0f172a;">Confirmation réussie !</h1>
                    <p>Votre email <strong>${subscriber.email}</strong> est maintenant inscrit à la newsletter Umbrella.</p>
                    <p>Vous recevrez bientôt nos actualités et offres exclusives.</p>
                    <a href="${process.env.FRONTEND_URL}" style="display: inline-block; background: #f5c400; color: #0f172a; padding: 12px 30px; border-radius: 40px; text-decoration: none; font-weight: 600; margin-top: 20px;">Retour au site</a>
                </div>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('Erreur confirmation:', error);
        res.status(500).send('Erreur lors de la confirmation');
    }
});

// Désabonnement
app.get('/api/unsubscribe/:token', async (req, res) => {
    const { token } = req.params;
    console.log(`🔓 Désabonnement du token: ${token}`);
    
    try {
        const { data: link } = await supabase
            .from('unsubscribe_links')
            .select('subscriber_id')
            .eq('token', token)
            .single();
        
        if (!link) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>Erreur</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1 style="color: #ef4444;">❌ Lien invalide</h1>
                    <p>Ce lien de désabonnement est invalide.</p>
                </body>
                </html>
            `);
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
        
        console.log(`✅ Désabonnement confirmé`);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Désabonnement</title></head>
            <body style="font-family: 'Plus Jakarta Sans', sans-serif; text-align: center; padding: 50px; background: #f8fafc;">
                <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1);">
                    <div style="font-size: 4rem;">✅</div>
                    <h1 style="color: #0f172a;">Désabonnement confirmé</h1>
                    <p>Vous ne recevrez plus nos newsletters.</p>
                    <p>Vous pouvez vous réabonner à tout moment sur notre site.</p>
                    <a href="${process.env.FRONTEND_URL}/subscribe.html" style="display: inline-block; background: #f5c400; color: #0f172a; padding: 12px 30px; border-radius: 40px; text-decoration: none; font-weight: 600; margin-top: 20px;">Se réabonner</a>
                </div>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('Erreur désabonnement:', error);
        res.status(500).send('Erreur');
    }
});

// Nombre d'abonnés (authentifié)
app.get('/api/subscribers/count', async (req, res) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    
    try {
        const { count, error } = await supabase
            .from('subscribers')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'active');
        
        if (error) throw error;
        
        res.json({ count: count || 0 });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur récupération' });
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
        
        if (!subscribers || subscribers.length === 0) {
            return res.json({ success: true, sent: 0, total: 0, message: 'Aucun abonné actif' });
        }
        
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
        <body style="font-family: 'Plus Jakarta Sans', sans-serif; padding: 40px; background: #f8fafc;">
            <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1);">
                <div style="text-align: center; margin-bottom: 20px;">
                    <div style="font-size: 3rem;">📧</div>
                </div>
                <h1 style="color: #0f172a; text-align: center; font-size: 1.5rem;">Confirmez votre inscription</h1>
                <p style="color: #334155; margin: 20px 0;">Bonjour${name ? ` ${name}` : ''},</p>
                <p style="color: #334155;">Merci de vous être inscrit à la newsletter Umbrella. Pour confirmer votre abonnement, cliquez sur le bouton ci-dessous :</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${confirmUrl}" style="background: #f5c400; color: #0f172a; padding: 12px 30px; border-radius: 40px; text-decoration: none; display: inline-block; font-weight: 600;">Confirmer mon inscription</a>
                </div>
                <p style="color: #64748b; font-size: 0.8rem; text-align: center;">Si vous n'avez pas demandé cette inscription, ignorez simplement cet email.</p>
                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                <p style="color: #94a3b8; font-size: 0.7rem; text-align: center;">© ${new Date().getFullYear()} Umbrella. Tous droits réservés.</p>
            </div>
        </body>
        </html>
    `;
    
    await sendEmail(email, 'Confirmez votre inscription à la newsletter Umbrella', html);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ CORS activé pour les origines: ${allowedOrigins.join(', ')}`);
});
