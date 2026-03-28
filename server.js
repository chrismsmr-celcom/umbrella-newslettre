const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();

// ==================== CORS ====================
app.use(cors({
    origin: ['https://chrismsmr-celcom.github.io', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

app.use(express.json());

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

async function sendEmail(to, subject, html) {
    const { data, error } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [to],
        subject: subject,
        html: html
    });
    if (error) throw error;
    return data;
}

// ==================== ROUTE INSCRIPTION ====================
app.post('/api/subscribe', async (req, res) => {
    console.log('📧 Requête reçue:', req.body);
    
    const { email, name, source } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email requis' });
    }
    
    try {
        // Vérifier si l'email existe déjà
        const { data: existing, error: findError } = await supabase
            .from('subscribers')
            .select('id, status')
            .eq('email', email)
            .maybeSingle();
        
        if (existing && existing.status === 'active') {
            return res.status(400).json({ error: 'Cet email est déjà abonné' });
        }
        
        const token = generateToken();
        
        // Insérer ou mettre à jour
        const { error: insertError } = await supabase
            .from('subscribers')
            .upsert({
                email,
                name: name || null,
                status: 'pending',
                confirmation_token: token,
                ip_address: req.ip || req.headers['x-forwarded-for'],
                user_agent: req.headers['user-agent'],
                source: source || 'api'
            }, { onConflict: 'email' });
        
        if (insertError) {
            console.error('Erreur insertion:', insertError);
            throw insertError;
        }
        
        // Envoyer l'email de confirmation
        const confirmUrl = `${process.env.BACKEND_URL || 'https://umbrella-newslettre-api.onrender.com'}/api/confirm/${token}`;
        
        const html = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Confirmation</title></head>
            <body style="font-family: Arial; padding: 40px;">
                <div style="max-width: 500px; margin: 0 auto;">
                    <h1>Confirmez votre inscription</h1>
                    <p>Bonjour${name ? ` ${name}` : ''},</p>
                    <p>Merci de vous être inscrit à la newsletter Umbrella.</p>
                    <a href="${confirmUrl}" style="background: #f5c400; color: #0f172a; padding: 12px 24px; text-decoration: none; border-radius: 40px; display: inline-block;">Confirmer mon inscription</a>
                    <p style="margin-top: 20px; font-size: 12px; color: #666;">Si vous n'avez pas demandé cette inscription, ignorez cet email.</p>
                </div>
            </body>
            </html>
        `;
        
        await sendEmail(email, 'Confirmez votre inscription', html);
        
        console.log(`✅ Email de confirmation envoyé à ${email}`);
        res.json({ success: true, message: 'Email de confirmation envoyé' });
        
    } catch (error) {
        console.error('❌ Erreur inscription:', error);
        res.status(500).json({ error: 'Erreur lors de l\'inscription: ' + error.message });
    }
});

// ==================== ROUTE CONFIRMATION ====================
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
            return res.status(400).send(`
                <h1>❌ Lien invalide</h1>
                <p>Ce lien de confirmation est invalide ou a expiré.</p>
                <a href="${process.env.FRONTEND_URL}/subscribe.html">S'inscrire à nouveau</a>
            `);
        }
        
        // Créer un token de désabonnement
        const unsubscribeToken = generateToken();
        await supabase
            .from('unsubscribe_links')
            .insert({
                subscriber_id: subscriber.id,
                token: unsubscribeToken
            });
        
        res.send(`
            <h1>✅ Confirmation réussie !</h1>
            <p>Votre email ${subscriber.email} est maintenant inscrit.</p>
            <a href="${process.env.FRONTEND_URL}">Retour au site</a>
        `);
        
    } catch (error) {
        console.error('Erreur confirmation:', error);
        res.status(500).send('Erreur lors de la confirmation');
    }
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Umbrella Newsletter API is running',
        endpoints: ['GET /api/health', 'POST /api/subscribe', 'GET /api/confirm/:token']
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
