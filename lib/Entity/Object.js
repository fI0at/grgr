"use strict";
/*
    DiepCustom - custom tank game server that shares diep.io's WebSocket protocol
    Copyright (C) 2022 ABCxFF (github.com/ABCxFF)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>
*/
Object.defineProperty(exports, "__esModule", { value: true });
const util = require("../util");
const Velocity_1 = require("../Physics/Velocity");
const Vector_1 = require("../Physics/Vector");
const FieldGroups_1 = require("../Native/FieldGroups");
const Entity_1 = require("../Native/Entity");
const Enums_1 = require("../Const/Enums");
/**
 * The animator for how entities delete (the opacity and size fade out).
 */
class DeletionAnimation {
    constructor(entity) {
        /** The current frame of the deletion animation. */
        this.frame = 5;
        this.entity = entity;
    }
    /** Animates the death animation. Called by the owner's internal tick. */
    tick() {
        if (this.frame === -1)
            throw new Error("Animation failed. Entity should be gone by now");
        switch (this.frame) {
            case 0: {
                this.entity.destroy(false);
                this.frame = -1;
                return;
            }
            case 5:
                this.entity.style.opacity = 1 - (1 / 6);
            default:
                this.entity.physics.size *= 1.1;
                this.entity.style.opacity -= 1 / 6;
                if (this.entity.style.values.opacity < 0)
                    this.entity.style.opacity = 0;
                break;
        }
        this.frame -= 1;
    }
}
/**
 * Object Entity is used for all entities with relations,
 * physics, position, and style field groups. All physics
 * are applied through this class. **This class represents
 * everything you can see in game.**
 */
class ObjectEntity extends Entity_1.Entity {
    constructor(game) {
        super(game);
        /** Always existant relations field group. Present in all objects. */
        this.relations = new FieldGroups_1.RelationsGroup(this);
        /** Always existant physics field group. Present in all objects. */
        this.physics = new FieldGroups_1.PhysicsGroup(this);
        /** Always existant position field group. Present in all objects. */
        this.position = new FieldGroups_1.PositionGroup(this);
        /** Always existant style field group. Present in all objects. */
        this.style = new FieldGroups_1.StyleGroup(this);
        /** Animator used for deletion animation */
        this.deletionAnimation = null;
        /** When set to true (the default), physics are applied to the entity. */
        this.isPhysical = true;
        /** Set to true of the entity has a parent. */
        this.isChild = false;
        /** All children of the object entity. */
        this.children = [];
        /** Used to determine the parent of all parents. */
        this.rootParent = this;
        /** Whether or not the entity is near a camera. */
        this.isViewed = false;
        /** Velocity used for physics. */
        this.velocity = new Velocity_1.default();
        /** Acceleration used for physics. */
        this.accel = new Vector_1.default();
        /** Cache of all ObjectEntitys who are colliding with `this` one at the current tick */
        this.cachedCollisions = [];
        /** Tick that the cache was taken. */
        this.cachedTick = 0;
        this.style.zIndex = game.entities.zIndex++;
    }
    /** Calls the deletion animation, unless animate is set to false, in that case it instantly deletes. */
    destroy(animate = true) {
        if (!animate) {
            if (this.deletionAnimation)
                this.deletionAnimation = null;
            this.delete();
        }
        else if (!this.deletionAnimation) { // if we aren't already deleting
            this.deletionAnimation = new DeletionAnimation(this);
        }
    }
    /** Extends Entity.delete, but removes child from parent. */
    delete() {
        if (this.isChild) {
            util.removeFast(this.rootParent.children, this.rootParent.children.indexOf(this));
        }
        else {
            for (const child of this.children) {
                child.isChild = false;
                child.delete();
            }
            this.children = [];
        }
        super.delete();
    }
    /** Applies acceleration to the object. */
    addAcceleration(angle, acceleration, negateFriction = false) {
        if (negateFriction) {
            const frictionComponent = this.velocity.angleComponent(angle) * .1;
            acceleration += frictionComponent;
        }
        this.accel.add(Vector_1.default.fromPolar(angle, acceleration));
    }
    /** Sets the velocity of the object. */
    setVelocity(angle, magnitude) {
        // this.a.set(Vector.fromPolar(angle, acceleration));
        this.velocity.setPosition(this.position.values);
        this.velocity.set(Vector_1.default.fromPolar(angle, magnitude));
    }
    /** Updates the acceleration. */
    maintainVelocity(angle, maxSpeed) {
        // acceleration * 10 = max speed. this relationship is caused by friction
        this.accel.add(Vector_1.default.fromPolar(angle, maxSpeed * 0.1));
    }
    /** Internal physics method used for calculating the current position of the object. */
    applyPhysics() {
        if (!this.isViewed) {
            this.velocity.setPosition(this.position.values);
            this.accel.set(new Vector_1.default(0, 0));
            return;
        }
        this.velocity.setPosition(this.position.values);
        // apply friction opposite of current velocity
        this.addAcceleration(this.velocity.angle, this.velocity.magnitude * -0.1);
        // delta velocity
        this.velocity.add(this.accel);
        if (this.velocity.magnitude < 0.01)
            this.velocity.magnitude = 0;
        // when being deleted, entities slow down half speed
        else if (this.deletionAnimation)
            this.velocity.magnitude /= 2;
        this.position.x += this.velocity.x;
        this.position.y += this.velocity.y;
        // don't accumulate acceleration across ticks
        this.accel.set(new Vector_1.default(0, 0));
        // Keep things in the arena
        if (!(this.physics.values.objectFlags & Enums_1.ObjectFlags.canEscapeArena)) {
            const arena = this.game.arena;
            xPos: {
                if (this.position.values.x < arena.arena.values.leftX - arena.ARENA_PADDING)
                    this.position.x = arena.arena.values.leftX - arena.ARENA_PADDING;
                else if (this.position.values.x > arena.arena.values.rightX + arena.ARENA_PADDING)
                    this.position.x = arena.arena.values.rightX + arena.ARENA_PADDING;
                else
                    break xPos;
                this.velocity.position.x = this.position.values.x;
            }
            yPos: {
                if (this.position.values.y < arena.arena.values.topY - arena.ARENA_PADDING)
                    this.position.y = arena.arena.values.topY - arena.ARENA_PADDING;
                else if (this.position.values.y > arena.arena.values.bottomY + arena.ARENA_PADDING)
                    this.position.y = arena.arena.values.bottomY + arena.ARENA_PADDING;
                else
                    break yPos;
                this.velocity.position.y = this.position.values.y;
            }
        }
    }
    /** Applies knockback after hitting `entity` */
    receiveKnockback(entity) {
        let kbMagnitude = this.physics.values.absorbtionFactor * entity.physics.values.pushFactor;
        let kbAngle;
        let diffY = this.position.values.y - entity.position.values.y;
        let diffX = this.position.values.x - entity.position.values.x;
        // Prevents drone stacking etc
        if (diffX === 0 && diffY === 0)
            kbAngle = Math.random() * Math.PI * 2;
        else
            kbAngle = Math.atan2(diffY, diffX);
        if ((entity.physics.values.objectFlags & Enums_1.ObjectFlags.wall || entity.physics.values.objectFlags & Enums_1.ObjectFlags.base) && !(this.position.values.motion & Enums_1.MotionFlags.canMoveThroughWalls)) {
            this.accel.magnitude *= 0.3;
            // this.velocity.magnitude *= 0.3;
            kbMagnitude /= 0.3;
        }
        if (entity.physics.values.sides === 2) {
            if (this.position.values.motion & Enums_1.MotionFlags.canMoveThroughWalls) {
                kbMagnitude = 0;
            }
            else if ((!(entity.physics.values.objectFlags & Enums_1.ObjectFlags.base) || entity.physics.values.pushFactor !== 0) && this.relations.values.owner instanceof ObjectEntity && !(Entity_1.Entity.exists(this.relations.values.team) && this.relations.values.team === entity.relations.values.team)) {
                // this is a bit off still. k
                this.velocity.setPosition(this.position.values);
                this.setVelocity(0, 0);
                this.destroy(true); // Kills off bullets etc
                return;
            }
            else {
                const relA = Math.cos(kbAngle) / entity.physics.values.size;
                const relB = Math.sin(kbAngle) / entity.physics.values.width;
                if (Math.abs(relA) <= Math.abs(relB)) {
                    if (relB < 0) {
                        this.addAcceleration(Math.PI * 3 / 2, kbMagnitude);
                    }
                    else {
                        this.addAcceleration(Math.PI * 1 / 2, kbMagnitude);
                    }
                }
                else {
                    if (relA < 0) {
                        this.addAcceleration(Math.PI, kbMagnitude);
                    }
                    else {
                        this.addAcceleration(0, kbMagnitude);
                    }
                }
            }
        }
        else {
            this.addAcceleration(kbAngle, kbMagnitude);
        }
    }
    /** Detects collisions. */
    findCollisions() {
        if (this.cachedTick === this.game.tick)
            return this.cachedCollisions;
        this.cachedTick = this.game.tick;
        this.cachedCollisions = [];
        // Lets just let the game deal with this next tick.
        if (this.hash === 0)
            return [];
        if (this.physics.values.sides === 0)
            return [];
        const entities = this.game.entities.collisionManager.retrieveEntitiesByEntity(this);
        for (let i = 0; i < entities.length; ++i) {
            const entity = entities[i];
            if (entity === this)
                continue;
            if (entity.deletionAnimation)
                continue;
            if (entity.relations.values.team === this.relations.values.team) {
                if ((entity.physics.values.objectFlags & Enums_1.ObjectFlags.noOwnTeamCollision) ||
                    (this.physics.values.objectFlags & Enums_1.ObjectFlags.noOwnTeamCollision))
                    continue;
                if (entity.relations.values.owner !== this.relations.values.owner) {
                    if ((entity.physics.values.objectFlags & Enums_1.ObjectFlags.onlySameOwnerCollision) ||
                        (this.physics.values.objectFlags & Enums_1.ObjectFlags.onlySameOwnerCollision))
                        continue;
                }
            }
            if (this.relations.values.team === this.game.arena && (entity.physics.values.objectFlags & Enums_1.ObjectFlags.base))
                continue;
            if (entity.physics.values.sides === 0)
                continue;
            if (entity.physics.values.sides === 2 && this.physics.values.sides === 2) {
                // in Diep.io source code, rectangles do not support collisions
                // hence, they are not supported here
            }
            else if (this.physics.values.sides !== 2 && entity.physics.values.sides === 2) {
                const dX = util.constrain(this.position.values.x, entity.position.values.x - entity.physics.values.size / 2, entity.position.values.x + entity.physics.values.size / 2) - this.position.values.x;
                const dY = util.constrain(this.position.values.y, entity.position.values.y - entity.physics.values.width / 2, entity.position.values.y + entity.physics.values.width / 2) - this.position.values.y;
                if (dX ** 2 + dY ** 2 <= this.physics.size ** 2)
                    this.cachedCollisions.push(entity);
            }
            else if (this.physics.values.sides === 2 && entity.physics.values.sides !== 2) {
                const dX = util.constrain(entity.position.values.x, this.position.values.x - this.physics.values.size / 2, this.position.values.x + this.physics.values.size / 2) - entity.position.values.x;
                const dY = util.constrain(entity.position.values.y, this.position.values.y - this.physics.values.width / 2, this.position.values.y + this.physics.values.width / 2) - entity.position.values.y;
                if (dX ** 2 + dY ** 2 <= entity.physics.size ** 2)
                    this.cachedCollisions.push(entity);
            }
            else {
                if ((entity.position.values.x - this.position.values.x) ** 2 + (entity.position.values.y - this.position.values.y) ** 2 <= (entity.physics.values.size + this.physics.values.size) ** 2) {
                    this.cachedCollisions.push(entity);
                }
            }
        }
        return this.cachedCollisions;
    }
    /** Sets the parent in align with everything else. */
    setParent(parent) {
        this.relations.parent = parent;
        this.rootParent = parent.rootParent;
        this.rootParent.children.push(this);
        this.isChild = true;
        this.isPhysical = false;
    }
    /** Returns the true world position (even for objects who have parents). */
    getWorldPosition() {
        let pos = new Vector_1.default(this.position.values.x, this.position.values.y);
        let entity = this;
        while (entity.relations.values.parent instanceof ObjectEntity) {
            if (!(entity.relations.values.parent.position.values.motion & Enums_1.MotionFlags.absoluteRotation))
                pos.angle += entity.position.values.angle;
            entity = entity.relations.values.parent;
            pos.x += entity.position.values.x;
            pos.y += entity.position.values.y;
        }
        return pos;
    }
    tick(tick) {
        this.deletionAnimation?.tick();
        if (this.isPhysical && !(this.deletionAnimation)) {
            const collidedEntities = this.findCollisions();
            for (let i = 0; i < collidedEntities.length; ++i) {
                this.receiveKnockback(collidedEntities[i]);
            }
        }
        if (this.isViewed)
            for (let i = 0; i < this.children.length; ++i)
                this.children[i].tick(tick);
    }
}
exports.default = ObjectEntity;
