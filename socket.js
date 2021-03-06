const jwt = require('jsonwebtoken')
const {Game,addPlayerToGame,passTurn,playCard,drawCardToPlayer,distributeInitialCard,checkWinCondition,restartGame,addBot} = require('./model')
const {User,addUser,findRank,addPoints,changeKarma} = require('./user')

module.exports = server=>{
    let io = (require('socket.io')(server))
    require('./waitingSocket')(io)
    io = io.of('/game')
    const gameSpecificInfo = new Map()

    const verify = (card,topCard)=>{
        if(card === 'Wild' || card==='Draw 4' || topCard === 'Wild' || topCard === 'Draw 4') return true
        const color = topCard.split(' ')[0]
        const action = topCard.split(' ').slice(1).join(' ')
        const color2 = card.split(' ')[0]
        const action2 = card.split(' ').slice(1).join(' ')
        return ((color===color2) || (action===action2))
    }

    const botPlayCard = (deck,currentTopCard)=>{
        for(let card of deck){
            if(verify(card,currentTopCard)) return card
        }
        return false
    }

    const botChooseColor = (deck)=>{
        const colors = ['red','blue','green','yellow'].map(c=>({color:c,number:0}))
        for(let card of deck){
            if(card === 'Draw 4' || card === 'Wild') continue
            const color = card.split(' ')[0]
            const index = colors.findIndex(e=>e.color===color)
            if(index <0) continue;
            colors[index].number++
        }
        return colors.sort((a,b)=>b.number-a.number)[0].color
    }

    io.on('connect',async (socket)=>{
        const actOnUser = async (func)=>{
            if(!socket.game.players[socket.userid].userid) return
            await func(socket.game.players[socket.userid].userid)
        }
    
        const competitiveAction = async (func)=>{
            if(!socket.game.gameMode.match(/Competitive/)) return
            else await actOnUser(func)
        }
        const userWinGame = async (playerid)=>{
            const id = socket.game.players[playerid].userid
            if(!id) return
            const user = await User.findById(id)
            user.gameWon++
            user.points+=(socket.game.gameMode === 'Competitive Player')?700:400
            await changeKarma(id,1)
            await user.save()
        }
        const emitToAll = (message,data)=>io.to(socket.room).emit(message,data)

        const update = async ()=>{
            const game = await (await Game.findById(socket.room).select('-deck'))
            emitToAll('Update',game)
        }

        const socketFunctionFactory = (message,func)=>socket.on(message,async (data)=>{
            socket.game = await Game.findById(socket.room)
            if(!socket.game) socket.emit('Critical Error')
            socket.originalTurn = socket.game.onTurn
            try{await func(data)}
            catch(e){
                console.log(e)
                socket.emit('Error',e.message)
            }
        })
        const turnFunctionFactory = (message,func)=>socketFunctionFactory(message,async (data)=>{
            if(socket.userid !== socket.game.onTurn) throw Error("Not your turn")
            if(!socket.game.inGame) throw Error("The game hasn't started yet")
            if(!socket.game.players[socket.userid].active) throw Error("You were inactive for 3 times")
            socket.game.players[socket.userid].strike = 0
            await socket.game.save()
            beginTurnTimer()
            await func(data)
            update()
        })
        const botPlay = async (id)=>{
            const myDeck = socket.game.players[id].cards
            let card = botPlayCard(myDeck,socket.game.currentTopCard)
            console.log(card)
            if(!card){
                card = await drawCardToPlayer(socket.game,id)
                if(!verify(card,socket.game.currentTopCard)) return
            }
            if(card.match(/Wild/) || card.match(/Draw 4/)) var color = botChooseColor(myDeck)
            if(card.match(/Draw 2/) || card.match(/Draw 4/) || card.match(/Skip/)) io.volatile.to(socket.room).emit('Emote',{emoji:'😈',userid:id})
            await playCard(socket.game,id,card,color)
        }
        const awaitTime = ()=>new Promise(r=>setTimeout(r,2000))
        const socketEndGame = async (win)=>{
            await competitiveAction(async()=>{
                for(let i = 0;i<socket.game.players.length;i++){
                    if(i===win){
                        await userWinGame(i)
                        continue
                    }
                    else{
                        const user = socket.game.players[i]
                        if(!user.active) continue
                        if(!user.userid) continue
                        await changeKarma(user.userid,1)
                        await addPoints(user.userid,(socket.game.gameMode === 'Competitive Player')?400:100)
                        const userUser = await user.findById(user.userid)
                        userUser.gameLost ++
                        await userUser.save()
                    }
                }
            })
            let changeInPoint
            await competitiveAction(()=>{
                if(socket.game.gameMode==='Competitive Player') return changeInPoint = socket.game.players.map((e,i)=>{
                    if(i===win) return 700
                    if(e.active) return 400
                    return 0
                })
                changeInPoint = socket.game.players.map((e,i)=>(i===win)?400:0)
            })
            console.log(changeInPoint)
            emitToAll('End Game',{win,changeInPoint})
        }

        const socketPassTurn = async ()=>{
            await passTurn(socket.game)
            if((!socket.game.inGame) || socket.game.endGame) return
            const win = await checkWinCondition(socket.game,socket.originalTurn)
            if(Number.isInteger(win)){
                socket.game.inGame = false
                socket.game.endGame = true
                await socket.game.save()
                cancelTurnTimer()
                socketEndGame(win)
            }
            if(socket.game.inGame&&(socket.game.players[socket.game.onTurn].bot || !socket.game.players[socket.game.onTurn].active)){
                await update()
                await awaitTime()
                await botPlay(socket.game.onTurn)
                socket.originalTurn = socket.game.onTurn
                await socketPassTurn(socket.game)
            }
            beginTurnTimer() 
        }

        const token = socket.handshake.query.token
        console.log('token',token)
        const {userid,id} = jwt.verify(token,process.env.SECRET_KEY)
        if((!userid && userid!==0) || !id){
            socket.emit('Critical Error')
            return socket.disconnect()
        }
        socket.room = id
        socket.userid = userid
        socket.game = await Game.findById(id)
        if(!socket.game) socket.emit('Critical Error')
        socket.join(socket.room)
        update()
        if(!gameSpecificInfo.has(socket.room)) gameSpecificInfo.set(socket.room,{})
        const setTurnSpecificInfo = (property,value)=>{
            const old = gameSpecificInfo.get(socket.room)
            old[property] = value
            gameSpecificInfo.set(socket.room,old)
        }
        const getTurnSpecificInfo = (property)=>gameSpecificInfo.get(socket.room)[property]

        const beginTurnTimer = ()=>{
            cancelTurnTimer()
            setTurnSpecificInfo('timer1',setTimeout(async ()=>{
                socket.game = await Game.findById(socket.room)
                socket.game.feed.push('Turn will automatically pass in 15 seconds')
                await socket.game.save()
                update()
            },15000))
            setTurnSpecificInfo('timer2',setTimeout(async ()=>{
                socket.game = await Game.findById(socket.room)
                await botPlay(socket.game.onTurn)
                socket.game.players[socket.game.onTurn].strike++
                await socket.game.save()
                if(socket.game.players[socket.game.onTurn].strike === 2){
                    socket.game.players[socket.game.onTurn].active = false
                    await socket.game.save()
                    await competitiveAction(async (id)=>{
                        await changeKarma(id,-1)
                        const user = await User.findById(id)
                        user.gameLost++
                        await user.save()
                        const playersRemain = socket.game.players.filter(e=>(!e.bot)&&e.active)
                        if(playersRemain.length>1) return
                        socket.game.inGame = false
                        socket.game.endGame = true
                        await socket.game.save()
                        cancelTurnTimer()
                        await socketEndGame(socket.game.players.indexOf(playersRemain[0]))
                    })
                }   
                if(!socket.game.players.every(e=>e.bot||e.active)){
                    await Game.findByIdAndDelete(socket.game._id)
                    emitToAll("Delete Inactive")
                    return
                }
                await socketPassTurn()
                update()
            },30000))
        }

        const cancelTurnTimer = ()=>{
            if(!getTurnSpecificInfo('timer1')) return
            clearInterval(getTurnSpecificInfo('timer1'))
            clearInterval(getTurnSpecificInfo('timer2'))
        }

        socketFunctionFactory('Start Game',async ()=>{
            if(socket.game.inGame) throw Error("The game had started")
            if(socket.game.players.length === 1) throw Error("Not enough players")
            socket.game.inGame = true
            await distributeInitialCard(socket.game)
            await socketPassTurn()
            update()
            await competitiveAction(async ()=>{
                for(let e of socket.game.players){
                    if(e.userid){
                        const user = await User.findById(e.userid)
                        user.gamePlayed++
                        await user.save()
                    }
                }
            })
            beginTurnTimer()
        })

        turnFunctionFactory('Draw Card',async ()=>{
            await drawCardToPlayer(socket.game,socket.userid)
        })

        const awaitChooseColor = ()=>new Promise(r=>{
            setTurnSpecificInfo('choosingColor',true)
            setTurnSpecificInfo('choosingColorFunction',r)
            socket.emit('Choose Color')
        })

        turnFunctionFactory('Choose Color',async (color)=>{
            if(getTurnSpecificInfo('choosingColor')) getTurnSpecificInfo('choosingColorFunction')(color)
        })

        turnFunctionFactory('Play Card',async (card)=>{
            if(card === 'Wild' || card === 'Draw 4') var extraColor = await awaitChooseColor()
            let next = (socket.userid+socket.game.turnCoefficient)
            if(next === socket.game.players.length) next = 0
            else if(next < 0) next = socket.game.players.length-1
            if((card.match(/Draw 2/) || card.match(/Draw 4/) || card.match(/Skip/)) && socket.game.players[next].bot) io.volatile.to(socket.room).emit('Emote',{emoji:'😡',userid:next})
            await playCard(socket.game,socket.userid,card,extraColor)
            await socketPassTurn()
        })

        turnFunctionFactory('Pass Turn',async ()=>{
            await socketPassTurn()
        })

        socketFunctionFactory('Restart Game',async ()=>{
            const newGame = await restartGame(socket.game)
            emitToAll('New Game',newGame)
        })

        socketFunctionFactory('Add Bot',async ()=>{
            if(socket.game.players.length === 4) return
            const id = socket.game.players.length
            const username = `Bot${id}🤖`
            await addBot(socket.game,username)
            update()
        })

        socket.on('Emote',(emoji)=>io.volatile.to(socket.room).emit('Emote',{emoji,userid:socket.userid}))
    })
}